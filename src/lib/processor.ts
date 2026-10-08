import {
  getUnprocessedBookmarks,
  countUnprocessedBookmarks,
  saveBookmarkAI,
  saveBookmarkAIResults,
  saveBookmarkMetadataOnly,
  markBookmarkFetchFailed,
  type Bookmark,
} from "./db";
import { fetchBookmarkContent, type BookmarkContent } from "./fetcher";
import {
  classifyBookmarksBatch,
  generateEmbeddingsBatch,
  classifyBookmark,
  generateEmbedding,
  isRateLimitError,
  isQuotaExhaustedError,
  parseRetryAfterMs,
  prepareCompactBookmarkText,
  prepareTextForEmbedding,
  globalRateLimiter,
  AI_CONFIG,
  type BookmarkMetadata,
  type BookmarkClassificationInput,
  type BookmarkEmbeddingInput,
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
  error?: string;
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

let throttleDelayMs = AI_CONFIG.MIN_REQUEST_INTERVAL_MS;
let initialBackoffMs = AI_CONFIG.INITIAL_BACKOFF_MS;
let batchSizeConfig = AI_CONFIG.CLASSIFICATION_BATCH_SIZE;

export function setThrottleDelayMsForTesting(ms: number): void {
  throttleDelayMs = ms;
  globalRateLimiter.setMinIntervalMs(ms);
}

export function resetThrottleDelayMsForTesting(): void {
  throttleDelayMs = AI_CONFIG.MIN_REQUEST_INTERVAL_MS;
  globalRateLimiter.setMinIntervalMs(AI_CONFIG.MIN_REQUEST_INTERVAL_MS);
}

export function setInitialBackoffMsForTesting(ms: number): void {
  initialBackoffMs = ms;
}

export function resetInitialBackoffMsForTesting(): void {
  initialBackoffMs = AI_CONFIG.INITIAL_BACKOFF_MS;
}

export function setBatchSizeForTesting(size: number): void {
  batchSizeConfig = size;
}

export function resetBatchSizeForTesting(): void {
  batchSizeConfig = AI_CONFIG.CLASSIFICATION_BATCH_SIZE;
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
 * - Global Gemini request limiter: limits concurrency, enforces minimum interval, and handles backoff.
 * - Batching: classifies and embeds bookmarks in configurable chunks (default: 10).
 * - Distinguishes temporary 429s (exponential backoff + jitter) from permanent quota exhaustion (pauses cleanly).
 * - Dead URL handling: marks unreachables as fetch_failed so they are not retried indefinitely.
 * - Resumable and error-isolated: successful bookmarks in a batch are persisted even if one fails.
 * - Returns an abort() function that cleanly suspends execution without state corruption.
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

      let currentBackoffMs = initialBackoffMs;
      let pausePromise: Promise<void> | null = null;

      const triggerBackoff = async (err?: unknown): Promise<void> => {
        if (pausePromise) {
          await pausePromise;
          return;
        }

        // Calculate backoff duration with Retry-After and jitter
        let waitMs = currentBackoffMs;
        const retryAfter = parseRetryAfterMs(err);
        if (retryAfter !== null && retryAfter > 0) {
          waitMs = Math.max(waitMs, retryAfter);
        } else {
          // Add 10-25% random jitter to avoid synchronized retry storms
          const jitter = Math.floor(Math.random() * (waitMs * 0.25));
          waitMs += jitter;
        }

        // Inform the global rate limiter
        globalRateLimiter.setBackoff(waitMs);

        const durationSec = Math.max(1, Math.ceil(waitMs / 1000));
        currentQueueStats.status = "backing_off";

        let resolvePause: () => void;
        pausePromise = new Promise<void>((res) => {
          resolvePause = res;
        });

        try {
          const stepMs = Math.min(1000, Math.max(10, Math.floor(waitMs / durationSec)));
          for (let s = durationSec; s > 0; s--) {
            if (isAborted()) break;
            currentQueueStats.backoffSecondsRemaining = s;
            onProgress?.({ ...currentQueueStats });
            await cancelableSleep(stepMs, isAborted);
          }
          // Exponential increase up to max backoff
          currentBackoffMs = Math.min(currentBackoffMs * 2, AI_CONFIG.MAX_BACKOFF_MS);
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

      // Loop batches of unprocessed bookmarks until none remain or queue aborted
      while (!isAborted()) {
        await waitIfBackingOff();
        if (isAborted()) break;

        const batch: Bookmark[] = await getUnprocessedBookmarks(batchSizeConfig);
        if (batch.length === 0) {
          currentQueueStats.status = "completed";
          currentQueueStats.currentUrl = undefined;
          onProgress?.({ ...currentQueueStats });
          break;
        }

        // Step 1: Fetch content for bookmarks in this batch
        interface FetchedItem {
          bookmark: Bookmark;
          content: BookmarkContent;
        }
        const reachableItems: FetchedItem[] = [];

        for (const bookmark of batch) {
          if (isAborted()) break;
          currentQueueStats.currentUrl = bookmark.url;
          onProgress?.({ ...currentQueueStats });

          try {
            const content = await fetchBookmarkContent(bookmark.url);
            if (content.isUnreachable || content.error) {
              await markBookmarkFetchFailed(
                bookmark.id,
                content.error || "Unreachable URL"
              );
              currentQueueStats.failed++;
              onProgress?.({ ...currentQueueStats });
              notifyBookmarkUpdated(bookmark.id, false);
            } else {
              reachableItems.push({ bookmark, content });
            }
          } catch (fetchErr: any) {
            const errMsg = fetchErr?.message || String(fetchErr);
            await markBookmarkFetchFailed(bookmark.id, errMsg);
            currentQueueStats.failed++;
            onProgress?.({ ...currentQueueStats });
            notifyBookmarkUpdated(bookmark.id, false);
          }
        }

        if (isAborted()) break;
        if (reachableItems.length === 0) {
          continue;
        }

        // Step 2 & 3: Batch Classification and Batch Embeddings with 429 Retry Loop
        let batchProcessedSuccessfully = false;

        while (!isAborted() && !batchProcessedSuccessfully) {
          await waitIfBackingOff();
          if (isAborted()) break;

          try {
            // A. Batch Classification
            const classificationInputs: BookmarkClassificationInput[] = reachableItems.map(
              ({ bookmark, content }) => ({
                id: bookmark.id,
                title: content.title || bookmark.title || "",
                description: content.description || bookmark.description || "",
                rawText: content.rawText || "",
              })
            );

            const classificationMap = await classifyBookmarksBatch(
              classificationInputs,
              apiKey,
              { throwOnRateLimit: true }
            );

            // B. Batch Embeddings
            const embeddingInputs: BookmarkEmbeddingInput[] = reachableItems.map(
              ({ bookmark, content }) => {
                const textToEmbed = prepareTextForEmbedding({
                  title: content.title || bookmark.title || "",
                  description: content.description || bookmark.description || "",
                  rawText: content.rawText || "",
                });
                return {
                  id: bookmark.id,
                  text: textToEmbed,
                };
              }
            );

            let embeddingsList: { id: string; embedding: number[] }[] = [];
            try {
              embeddingsList = await generateEmbeddingsBatch(
                embeddingInputs,
                apiKey,
                { throwOnRateLimit: true }
              );
            } catch (embErr) {
              if (isRateLimitError(embErr)) {
                // Let the outer catch handle rate limiting
                throw embErr;
              }
              // If embedding fails with a non-429 error, still persist classification metadata
              console.error("Batch embedding failed with non-rate-limit error:", embErr);
              embeddingsList = embeddingInputs.map((i) => ({ id: i.id, embedding: [] }));
            }

            const embeddingMap = new Map<string, number[]>();
            for (const item of embeddingsList) {
              embeddingMap.set(item.id, item.embedding);
            }

            // C. Persist results
            const resultsToSave = reachableItems
              .filter(({ bookmark }) => classificationMap.has(bookmark.id))
              .map(({ bookmark }) => ({
                bookmarkId: bookmark.id,
                metadata: classificationMap.get(bookmark.id)!,
                embedding: embeddingMap.get(bookmark.id) || [],
              }));

            await saveBookmarkAIResults(resultsToSave);

            // Any items in reachableItems that model omitted get classified individually or failed
            for (const { bookmark } of reachableItems) {
              if (classificationMap.has(bookmark.id)) {
                currentQueueStats.processed++;
                notifyBookmarkUpdated(bookmark.id, true);
              } else {
                // Missing from classification output: mark failed so queue is not stuck
                await markBookmarkFetchFailed(
                  bookmark.id,
                  "AI classification output missing for bookmark ID"
                );
                currentQueueStats.failed++;
                notifyBookmarkUpdated(bookmark.id, false);
              }
            }

            // Reset backoff on success
            currentBackoffMs = initialBackoffMs;
            onProgress?.({ ...currentQueueStats });
            batchProcessedSuccessfully = true;
          } catch (err: any) {
            if (isQuotaExhaustedError(err)) {
              console.error("Gemini hard quota exhaustion detected:", err);
              currentQueueStats.status = "paused";
              currentQueueStats.error = "Gemini quota exhausted. Processing paused.";
              currentQueueStats.currentUrl = undefined;
              onProgress?.({ ...currentQueueStats });
              abort();
              return;
            } else if (isRateLimitError(err)) {
              console.warn(
                `Gemini 429 rate limit hit for batch of ${reachableItems.length} bookmarks, backing off...`
              );
              await triggerBackoff(err);
              // Will retry the batch after backoff completes
            } else {
              console.error("Unrecoverable batch AI processing error:", err);
              // Mark all items in this batch as failed so they don't block the queue
              for (const { bookmark } of reachableItems) {
                await markBookmarkFetchFailed(bookmark.id, String(err));
                currentQueueStats.failed++;
                notifyBookmarkUpdated(bookmark.id, false);
              }
              onProgress?.({ ...currentQueueStats });
              batchProcessedSuccessfully = true;
            }
          }
        }
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
  if (unprocessed.length === 0) {
    return { processedCount: 0, items: [] };
  }

  // 1. Fetch web content
  interface FetchedItem {
    bookmark: Bookmark;
    content: BookmarkContent;
  }
  const reachableItems: FetchedItem[] = [];

  for (const bookmark of unprocessed) {
    try {
      const content = await fetchBookmarkContent(bookmark.url);
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
      reachableItems.push({ bookmark, content });
    } catch (fetchErr: any) {
      const errMsg = fetchErr?.message || String(fetchErr);
      await markBookmarkFetchFailed(bookmark.id, errMsg);
      items.push({
        bookmarkId: bookmark.id,
        url: bookmark.url,
        success: false,
        error: errMsg,
      });
    }
  }

  if (reachableItems.length === 0) {
    return {
      processedCount: 0,
      items,
    };
  }

  // 2. Batch classification
  const classificationInputs: BookmarkClassificationInput[] = reachableItems.map(
    ({ bookmark, content }) => ({
      id: bookmark.id,
      title: content.title || bookmark.title || "",
      description: content.description || bookmark.description || "",
      rawText: content.rawText || "",
    })
  );

  let classificationMap = new Map<string, BookmarkMetadata>();
  try {
    classificationMap = await classifyBookmarksBatch(
      classificationInputs,
      apiKey
    );
  } catch (classErr) {
    console.error("Batch classification failed in processNextBatch:", classErr);
    // Fallback: try individual classification
    for (const item of classificationInputs) {
      try {
        const meta = await classifyBookmark(item, apiKey);
        classificationMap.set(item.id, meta);
      } catch (indErr) {
        console.error(`Individual classification failed for ${item.id}:`, indErr);
      }
    }
  }

  // 3. Batch embeddings
  const embeddingInputs: BookmarkEmbeddingInput[] = reachableItems.map(
    ({ bookmark, content }) => {
      const textToEmbed = prepareTextForEmbedding({
        title: content.title || bookmark.title || "",
        description: content.description || bookmark.description || "",
        rawText: content.rawText || "",
      });
      return {
        id: bookmark.id,
        text: textToEmbed,
      };
    }
  );

  let embeddingsList: { id: string; embedding: number[] }[] = [];
  try {
    embeddingsList = await generateEmbeddingsBatch(embeddingInputs, apiKey);
  } catch (embErr) {
    console.error("Batch embedding failed in processNextBatch:", embErr);
    // Fallback: try individual embeddings
    for (const item of embeddingInputs) {
      try {
        const emb = await generateEmbedding(item.text, apiKey);
        embeddingsList.push({ id: item.id, embedding: emb });
      } catch (indErr) {
        console.error(`Individual embedding failed for ${item.id}:`, indErr);
      }
    }
  }

  const embeddingMap = new Map<string, number[]>();
  for (const item of embeddingsList) {
    embeddingMap.set(item.id, item.embedding);
  }

  // 4. Save results to database
  const resultsToSave = reachableItems
    .filter(({ bookmark }) => classificationMap.has(bookmark.id))
    .map(({ bookmark }) => ({
      bookmarkId: bookmark.id,
      metadata: classificationMap.get(bookmark.id)!,
      embedding: embeddingMap.get(bookmark.id) || [],
    }));

  await saveBookmarkAIResults(resultsToSave);

  for (const { bookmark } of reachableItems) {
    const meta = classificationMap.get(bookmark.id);
    if (meta) {
      items.push({
        bookmarkId: bookmark.id,
        url: bookmark.url,
        success: true,
        metadata: meta,
      });
    } else {
      items.push({
        bookmarkId: bookmark.id,
        url: bookmark.url,
        success: false,
        error: "AI processing failed",
      });
    }
  }

  return {
    processedCount: items.filter((item) => item.success).length,
    items,
  };
}
