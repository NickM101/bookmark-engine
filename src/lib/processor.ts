import {
  getUnprocessedBookmarks,
  countUnprocessedBookmarks,
  saveBookmarkAI,
  markBookmarkFetchFailed,
  type Bookmark,
} from "./db";
import { fetchBookmarkContent, type BookmarkContent } from "./fetcher";
import {
  classifyBookmark,
  generateEmbedding,
  isRateLimitError,
  type BookmarkMetadata,
} from "./ai";

export interface ProcessedBookmarkItem {
  bookmarkId: string;
  url: string;
  success: boolean;
  metadata?: BookmarkMetadata;
  error?: string;
}

export interface ProcessBatchResult {
  processedCount: number;
  items: ProcessedBookmarkItem[];
}

export interface QueueStats {
  status: "idle" | "running" | "paused" | "backing_off" | "completed";
  processed: number;
  total: number;
  failed: number;
  currentUrl?: string;
  backoffSecondsRemaining?: number;
}

/**
 * Helper to dispatch window event so UI queries can invalidate in real-time.
 */
function notifyBookmarkUpdated(bookmarkId: string, success: boolean): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent("bookmark-ai-updated", {
        detail: { bookmarkId, success },
      })
    );
  }
}

/**
 * Cancelable sleep that polls an abortion check at short intervals,
 * ensuring no dangling promises or hanging timers when abort() is invoked.
 */
export function cancelableSleep(
  ms: number,
  isAborted: () => boolean
): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted()) {
      resolve();
      return;
    }
    const checkInterval = 50;
    const start = Date.now();
    const timer = setInterval(() => {
      if (isAborted() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });
}

// Singleton state for the background queue runner
let activeAbortController: AbortController | null = null;
let currentQueueStats: QueueStats = {
  status: "idle",
  processed: 0,
  total: 0,
  failed: 0,
};

let throttleDelayMs = 750;
let initialBackoffMs = 10000;

export function setThrottleDelayMsForTesting(ms: number): void {
  throttleDelayMs = ms;
}

export function resetThrottleDelayMsForTesting(): void {
  throttleDelayMs = 750;
}

export function setInitialBackoffMsForTesting(ms: number): void {
  initialBackoffMs = ms;
}

export function resetInitialBackoffMsForTesting(): void {
  initialBackoffMs = 10000;
}

/**
 * Returns a snapshot of the current queue statistics.
 */
export function getQueueStats(): QueueStats {
  return { ...currentQueueStats };
}

/**
 * Returns true if the background queue is currently actively indexing or backing off.
 */
export function isQueueRunning(): boolean {
  return (
    currentQueueStats.status === "running" ||
    currentQueueStats.status === "backing_off"
  );
}

/**
 * Starts an automated, rate-limited background processing queue.
 *
 * Characteristics:
 * - Singleton queue runner: cancels any previously running queue instance.
 * - Concurrency: runs with a strict concurrency limit of 2 parallel jobs.
 * - Throttling: adds a 750ms delay between Gemini API calls to respect free-tier rate limits.
 * - Dead URL handling: if fetcher fails (404, DNS error, timeout, unreachable),
 *   marks the bookmark as fetch_failed in bookmarkAi so it is never retried infinitely.
 * - Rate limiting (HTTP 429): pauses the queue for 10s on first 429 and backs off exponentially,
 *   retrying the affected bookmark once the backoff period completes.
 * - Returns an abort() function that cleanly suspends queue execution without corrupting transactions.
 *
 * @param apiKey The user's Gemini API key
 * @param onProgress Callback invoked on queue state transitions and item completions
 * @returns Abort function to suspend processing
 */
export function startProcessingQueue(
  apiKey: string,
  onProgress?: (stats: QueueStats) => void
): () => void {
  // Cancel previous active run if one exists
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  const controller = new AbortController();
  activeAbortController = controller;

  const isAborted = () => controller.signal.aborted;

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
      if (currentQueueStats.status !== "completed") {
        currentQueueStats = {
          ...currentQueueStats,
          status: "paused",
          currentUrl: undefined,
          backoffSecondsRemaining: undefined,
        };
        onProgress?.({ ...currentQueueStats });
      }
      if (activeAbortController === controller) {
        activeAbortController = null;
      }
    }
  };

  // Run the queue in the background
  (async () => {
    try {
      const remainingCount = await countUnprocessedBookmarks();
      currentQueueStats = {
        status: "running",
        processed: 0,
        total: remainingCount,
        failed: 0,
      };
      onProgress?.({ ...currentQueueStats });

      if (remainingCount === 0) {
        currentQueueStats.status = "completed";
        currentQueueStats.currentUrl = undefined;
        onProgress?.({ ...currentQueueStats });
        return;
      }

      let backoffMs = initialBackoffMs; // Initial backoff
      let pausePromise: Promise<void> | null = null;

      const triggerBackoff = async (): Promise<void> => {
        if (pausePromise) {
          await pausePromise;
          return;
        }

        const durationSec = Math.max(1, Math.ceil(backoffMs / 1000));
        currentQueueStats.status = "backing_off";

        let resolvePause: () => void;
        pausePromise = new Promise<void>((res) => {
          resolvePause = res;
        });

        try {
          const stepMs = Math.min(1000, Math.max(10, Math.floor(backoffMs / durationSec)));
          for (let s = durationSec; s > 0; s--) {
            if (isAborted()) break;
            currentQueueStats.backoffSecondsRemaining = s;
            onProgress?.({ ...currentQueueStats });
            await cancelableSleep(stepMs, isAborted);
          }
          // Exponential backoff for subsequent consecutive 429 errors
          backoffMs = Math.min(backoffMs * 2, 60000);
        } finally {
          currentQueueStats.backoffSecondsRemaining = undefined;
          if (!isAborted()) {
            currentQueueStats.status = "running";
            onProgress?.({ ...currentQueueStats });
          }
          pausePromise = null;
          resolvePause!();
        }
      };

      const waitIfBackingOff = async (): Promise<boolean> => {
        if (isAborted()) return false;
        if (pausePromise) {
          await pausePromise;
        }
        return !isAborted();
      };

      const processBookmark = async (bookmark: Bookmark): Promise<boolean> => {
        if (isAborted()) return false;

        currentQueueStats.currentUrl = bookmark.url;
        onProgress?.({ ...currentQueueStats });

        // 1. Fetch webpage content
        let content: BookmarkContent;
        try {
          content = await fetchBookmarkContent(bookmark.url);
          if (content.isUnreachable || content.error) {
            await markBookmarkFetchFailed(
              bookmark.id,
              content.error || "Unreachable URL"
            );
            currentQueueStats.failed++;
            onProgress?.({ ...currentQueueStats });
            notifyBookmarkUpdated(bookmark.id, false);
            return true; // Marked as handled
          }
        } catch (fetchErr: any) {
          const errMsg = fetchErr?.message || String(fetchErr);
          await markBookmarkFetchFailed(bookmark.id, errMsg);
          currentQueueStats.failed++;
          onProgress?.({ ...currentQueueStats });
          notifyBookmarkUpdated(bookmark.id, false);
          return true; // Marked as handled
        }

        // 2. Classify and embed with retry loop on 429
        while (!isAborted()) {
          await waitIfBackingOff();
          if (isAborted()) return false;

          // Throttling delay before classify call
          await cancelableSleep(throttleDelayMs, isAborted);
          if (isAborted()) return false;

          try {
            const title = content.title || bookmark.title || "";
            const description = content.description || bookmark.description || "";
            const rawText = content.rawText || "";

            const metadata = await classifyBookmark(
              { title, description, rawText },
              apiKey,
              { throwOnRateLimit: true }
            );

            // Throttling delay before embed call
            await cancelableSleep(throttleDelayMs, isAborted);
            if (isAborted()) return false;

            const textToEmbed = [title, description, rawText.slice(0, 5000)]
              .filter((p) => p.trim().length > 0)
              .join("\n\n");

            const embedding = await generateEmbedding(textToEmbed, apiKey, {
              throwOnRateLimit: true,
            });

            // Persist AI metadata and embeddings to database
            await saveBookmarkAI(bookmark.id, metadata, embedding);

            // Reset backoff upon successful call
            backoffMs = initialBackoffMs;
            currentQueueStats.processed++;
            onProgress?.({ ...currentQueueStats });
            notifyBookmarkUpdated(bookmark.id, true);
            return true; // Bookmark successfully processed
          } catch (err: any) {
            if (isRateLimitError(err)) {
              console.warn(
                `Gemini 429 rate limit hit for ${bookmark.url}, backing off...`
              );
              await triggerBackoff();
              // Loop will retry this bookmark
            } else {
              console.error(`AI processing error for ${bookmark.url}:`, err);
              await markBookmarkFetchFailed(bookmark.id, String(err));
              currentQueueStats.failed++;
              onProgress?.({ ...currentQueueStats });
              notifyBookmarkUpdated(bookmark.id, false);
              return true;
            }
          }
        }

        return false;
      };

      // Loop batches of unprocessed bookmarks until none remain or queue aborted
      while (!isAborted()) {
        await waitIfBackingOff();
        if (isAborted()) break;

        const batch = await getUnprocessedBookmarks(10);
        if (batch.length === 0) {
          currentQueueStats.status = "completed";
          currentQueueStats.currentUrl = undefined;
          onProgress?.({ ...currentQueueStats });
          break;
        }

        // Concurrency limit of 2 parallel worker jobs
        let itemIndex = 0;
        const runWorker = async () => {
          while (!isAborted()) {
            await waitIfBackingOff();
            if (isAborted()) break;

            const idx = itemIndex++;
            if (idx >= batch.length) break;

            const bookmark = batch[idx];
            const completed = await processBookmark(bookmark);
            if (!completed && isAborted()) {
              break;
            }
          }
        };

        // Run 2 workers concurrently
        await Promise.all([runWorker(), runWorker()]);
      }
    } catch (queueErr) {
      console.error("Queue execution error:", queueErr);
    } finally {
      if (activeAbortController === controller) {
        activeAbortController = null;
      }
    }
  })();

  return abort;
}

/**
 * Background worker function that retrieves and processes the next batch
 * of unprocessed bookmarks (single batch, non-continuous).
 *
 * @param apiKey The user's Gemini API key
 * @param batchSize Number of bookmarks to process in this batch (defaults to 5)
 * @returns Result summary containing processed count and individual item statuses
 */
export async function processNextBatch(
  apiKey: string,
  batchSize: number = 5
): Promise<ProcessBatchResult> {
  const unprocessed: Bookmark[] = await getUnprocessedBookmarks(batchSize);

  const items: ProcessedBookmarkItem[] = [];

  for (const bookmark of unprocessed) {
    try {
      // 1. Fetch web content using fetcher.ts
      let content: BookmarkContent;
      try {
        content = await fetchBookmarkContent(bookmark.url);
        if (content.isUnreachable || content.error) {
          await markBookmarkFetchFailed(
            bookmark.id,
            content.error || "Unreachable URL"
          );
          items.push({
            bookmarkId: bookmark.id,
            url: bookmark.url,
            success: false,
            error: content.error || "Unreachable URL",
          });
          continue;
        }
      } catch (fetchErr: any) {
        const errMsg = fetchErr?.message || String(fetchErr);
        await markBookmarkFetchFailed(bookmark.id, errMsg);
        items.push({
          bookmarkId: bookmark.id,
          url: bookmark.url,
          success: false,
          error: errMsg,
        });
        continue;
      }

      const title = content.title || bookmark.title || "";
      const description = content.description || bookmark.description || "";
      const rawText = content.rawText || "";

      // 2. Classify bookmark content with Gemini API
      const metadata: BookmarkMetadata = await classifyBookmark(
        {
          title,
          description,
          rawText,
        },
        apiKey
      );

      // 3. Generate semantic embedding vector
      const textToEmbed = [title, description, rawText.slice(0, 5000)]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");

      const embedding: number[] = await generateEmbedding(textToEmbed, apiKey);

      // 4. Persist AI metadata and embeddings to SQLite via Drizzle
      await saveBookmarkAI(bookmark.id, metadata, embedding);

      items.push({
        bookmarkId: bookmark.id,
        url: bookmark.url,
        success: true,
        metadata,
      });
    } catch (err) {
      console.error(
        `Failed to process bookmark ${bookmark.id} (${bookmark.url}):`,
        err
      );
      items.push({
        bookmarkId: bookmark.id,
        url: bookmark.url,
        success: false,
        error: String(err),
      });
    }
  }

  return {
    processedCount: items.filter((item) => item.success).length,
    items,
  };
}
