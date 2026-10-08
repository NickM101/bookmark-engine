import { GoogleGenAI, Type } from "@google/genai";

export interface BookmarkMetadata {
  category: string;
  tags: string[];
  technologies: string[];
  summary: string;
}

export interface BookmarkClassificationInput {
  id: string;
  title: string;
  description: string;
  rawText: string;
}

export interface SingleBookmarkInput {
  title: string;
  description: string;
  rawText: string;
}

export interface BookmarkEmbeddingInput {
  id: string;
  text: string;
}

export interface BookmarkEmbeddingResult {
  id: string;
  embedding: number[];
}

export interface AiCallOptions {
  throwOnRateLimit?: boolean;
}

// Configurable constants with sensible defaults
export const AI_CONFIG = {
  CLASSIFICATION_BATCH_SIZE: 10,
  EMBEDDING_BATCH_SIZE: 10,
  CLASSIFICATION_MAX_CHARS: 4000,
  EMBEDDING_MAX_CHARS: 3000,
  MAX_CONCURRENT_REQUESTS: 1,
  MIN_REQUEST_INTERVAL_MS: 500,
  INITIAL_BACKOFF_MS: 10000,
  MAX_BACKOFF_MS: 60000,
};

// Reusable cached client map
const clientCache = new Map<string, GoogleGenAI>();

/**
 * Returns a cached GoogleGenAI client instance for the given API key
 * or creates and stores a new one.
 */
export function getOrCreateGenAIClient(apiKey: string): GoogleGenAI {
  const trimmed = apiKey.trim();
  let client = clientCache.get(trimmed);
  if (!client) {
    client = new GoogleGenAI({ apiKey: trimmed });
    clientCache.set(trimmed, client);
  }
  return client;
}

/**
 * Clears the cached GoogleGenAI client instances (useful for testing).
 */
export function clearGenAIClientCache(): void {
  clientCache.clear();
}

/**
 * Checks if an error corresponds to Gemini API rate limiting or quota exhaustion (HTTP 429).
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    msg.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  );
}

/**
 * Distinguishes permanent/hard quota exhaustion (daily/project quota or billing)
 * from temporary concurrency or rate-per-minute limits.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("daily") ||
    lower.includes("per_day") ||
    lower.includes("per-day") ||
    lower.includes("quota exceeded") ||
    lower.includes("insufficient_quota") ||
    lower.includes("billing")
  );
}

/**
 * Attempts to parse a Retry-After delay (in milliseconds) from an error message or response header.
 */
export function parseRetryAfterMs(error: unknown): number | null {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const secMatch = msg.match(
    /retry(?:-after|\s+after|\s+in)?[:\s]+(\d+)\s*(?:s|seconds)?\b/i
  );
  if (secMatch) {
    const val = parseInt(secMatch[1], 10);
    if (!isNaN(val) && val > 0) return val * 1000;
  }
  return null;
}

/**
 * Controlled taxonomy for software developer bookmarks.
 */
export const ALLOWED_CATEGORIES = [
  "Frontend",
  "Backend",
  "AI/ML",
  "DevOps",
  "Database",
  "Systems",
  "Mobile",
  "Tool",
  "Documentation",
  "Article",
  "Reference",
  "Career",
  "Security",
  "Design",
  "Other",
] as const;

/**
 * Prepares a compact, token-efficient representation of webpage content for AI classification.
 * Strips superfluous whitespace and truncates readable text while preserving essential metadata.
 */
export function prepareCompactBookmarkText(
  item: { title?: string | null; description?: string | null; rawText?: string | null },
  maxChars: number = AI_CONFIG.CLASSIFICATION_MAX_CHARS
): string {
  const parts: string[] = [];
  const title = (item.title || "").trim();
  if (title) parts.push(`Title: ${title}`);

  const desc = (item.description || "").trim();
  if (desc) parts.push(`Description: ${desc}`);

  const body = (item.rawText || "").trim();
  if (body) {
    parts.push(`Content: ${body.slice(0, maxChars)}`);
  }

  return parts.join("\n");
}

/**
 * Prepares a compact text string suitable for vector embedding.
 */
export function prepareTextForEmbedding(
  item: { title?: string | null; description?: string | null; rawText?: string | null },
  maxChars: number = AI_CONFIG.EMBEDDING_MAX_CHARS
): string {
  const parts: string[] = [];
  const title = (item.title || "").trim();
  if (title) parts.push(title);

  const desc = (item.description || "").trim();
  if (desc) parts.push(desc);

  const body = (item.rawText || "").trim();
  if (body) {
    parts.push(body.slice(0, maxChars));
  }

  return parts.filter((p) => p.length > 0).join("\n\n");
}

/**
 * Normalizes model-returned category against the controlled taxonomy.
 */
function sanitizeCategory(rawCategory: unknown): string {
  if (typeof rawCategory !== "string" || !rawCategory.trim()) {
    return "Other";
  }
  const trimmed = rawCategory.trim();
  const match = ALLOWED_CATEGORIES.find(
    (c) => c.toLowerCase() === trimmed.toLowerCase()
  );
  return match || trimmed;
}

/**
 * Normalizes model-returned string arrays (tags, technologies).
 */
function sanitizeStringArray(rawArray: unknown): string[] {
  if (!Array.isArray(rawArray)) return [];
  return rawArray
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

/**
 * Global rate limiter managing Gemini API requests across all workers.
 * Enforces maximum concurrency, minimum interval between requests,
 * and synchronized pause/backoff on HTTP 429 errors.
 */
export class GeminiRateLimiter {
  private activeRequests = 0;
  private lastRequestTime = 0;
  private queue: Array<() => void> = [];
  private backoffUntil = 0;

  constructor(
    private maxConcurrent: number = AI_CONFIG.MAX_CONCURRENT_REQUESTS,
    private minIntervalMs: number = AI_CONFIG.MIN_REQUEST_INTERVAL_MS
  ) {}

  public setMaxConcurrent(val: number): void {
    this.maxConcurrent = Math.max(1, val);
  }

  public setMinIntervalMs(val: number): void {
    this.minIntervalMs = Math.max(0, val);
  }

  public getBackoffRemainingMs(): number {
    const rem = this.backoffUntil - Date.now();
    return rem > 0 ? rem : 0;
  }

  public setBackoff(durationMs: number): void {
    const until = Date.now() + durationMs;
    if (until > this.backoffUntil) {
      this.backoffUntil = until;
    }
  }

  public async acquire(): Promise<void> {
    while (true) {
      // 1. If currently backed off, wait until backoff duration expires
      const backoffWait = this.getBackoffRemainingMs();
      if (backoffWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffWait));
        continue;
      }

      // 2. Check concurrency
      if (this.activeRequests < this.maxConcurrent) {
        // Check minimum interval between requests
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minIntervalMs) {
          const waitTime = this.minIntervalMs - elapsed;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }

        this.activeRequests++;
        this.lastRequestTime = Date.now();
        return;
      }

      // 3. Wait in queue
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
  }

  public release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.lastRequestTime = Date.now();
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  public reset(): void {
    this.activeRequests = 0;
    this.lastRequestTime = 0;
    this.backoffUntil = 0;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// Global singleton rate limiter instance
export const globalRateLimiter = new GeminiRateLimiter();

/**
 * Classifies a batch of bookmarks in a single Gemini generateContent request.
 * Maps output results strictly by bookmark ID to avoid positional mismatch.
 *
 * @param bookmarks Array of bookmark items with id, title, description, and rawText
 * @param apiKey The user's Gemini API key
 * @param options Optional AI call options
 * @returns Map from bookmark ID to parsed BookmarkMetadata
 */
export async function classifyBookmarksBatch(
  bookmarks: BookmarkClassificationInput[],
  apiKey: string,
  options?: AiCallOptions
): Promise<Map<string, BookmarkMetadata>> {
  const results = new Map<string, BookmarkMetadata>();
  if (!bookmarks || bookmarks.length === 0) {
    return results;
  }

  if (!apiKey || !apiKey.trim()) {
    throw new Error("Gemini API key is required for classification.");
  }

  const client = getOrCreateGenAIClient(apiKey);

  const formattedItems = bookmarks.map((b) => ({
    id: b.id,
    content: prepareCompactBookmarkText(b, AI_CONFIG.CLASSIFICATION_MAX_CHARS),
  }));

  const prompt =
    "Analyze the following software developer bookmarks and categorize each one.\n\n" +
    JSON.stringify(formattedItems, null, 2);

  const response = await globalRateLimiter.execute(async () => {
    return await client.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        systemInstruction:
          "You are an expert bookmark classifier for software developers. " +
          "Analyze the given list of webpages. Return a JSON array containing one object per input bookmark. " +
          "Each object MUST preserve the input 'id' and include 'category', 'tags', 'technologies', and 'summary'.\n" +
          "Permitted categories: " +
          ALLOWED_CATEGORIES.join(", ") +
          ".",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              category: { type: Type.STRING },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              technologies: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              summary: { type: Type.STRING },
            },
            required: ["id", "category", "tags", "technologies", "summary"],
          },
        },
      },
    });
  });

  const responseText = response.text;
  if (!responseText) {
    throw new Error("Received empty text response from Gemini API.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    console.error("Failed to parse Gemini batch classification JSON:", err);
    throw new Error(`Malformed JSON returned by Gemini: ${String(err)}`);
  }

  // Handle both array response and single object response
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rawId = (item as any).id;
    if (typeof rawId !== "string" || !rawId) {
      // If single item without id, map it if batch had only 1 item
      if (bookmarks.length === 1) {
        results.set(bookmarks[0].id, {
          category: sanitizeCategory((item as any).category),
          tags: sanitizeStringArray((item as any).tags),
          technologies: sanitizeStringArray((item as any).technologies),
          summary: typeof (item as any).summary === "string" ? (item as any).summary.trim() : "",
        });
      }
      continue;
    }

    results.set(rawId, {
      category: sanitizeCategory((item as any).category),
      tags: sanitizeStringArray((item as any).tags),
      technologies: sanitizeStringArray((item as any).technologies),
      summary: typeof (item as any).summary === "string" ? (item as any).summary.trim() : "",
    });
  }

  return results;
}

/**
 * Classifies a single bookmark (preserved for backward compatibility with existing callers/tests).
 */
export async function classifyBookmark(
  content: SingleBookmarkInput,
  apiKey: string,
  options?: AiCallOptions
): Promise<BookmarkMetadata> {
  try {
    if (!apiKey || !apiKey.trim()) {
      throw new Error("Gemini API key is required for classification.");
    }

    const ai = getOrCreateGenAIClient(apiKey);

    const prompt = `Webpage Content to Classify:
Title: ${content.title || "Untitled"}
Description: ${content.description || "No description provided"}
Body Text:
${content.rawText ? content.rawText.slice(0, 15000) : "No body text available"}`;

    const response = await globalRateLimiter.execute(async () => {
      return await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          systemInstruction:
            "You are a strict, expert bookmark organizer for a software developer. " +
            "Analyze the given webpage content (title, description, and readable body text) and categorize it. " +
            "You MUST return a raw JSON object matching the following structure:\n" +
            "{\n" +
            '  "category": "string (e.g. Frontend, Backend, AI/ML, DevOps, Database, Systems, Mobile, Tool, Documentation, Article, Reference, Career, Other)",\n' +
            '  "tags": ["array", "of", "relevant", "keyword", "strings"],\n' +
            '  "technologies": ["array", "of", "specific", "libraries", "languages", "or", "tools", "mentioned"],\n' +
            '  "summary": "Short 1-2 sentence concise summary explaining what this resource is and why it is useful."\n' +
            "}",
          responseMimeType: "application/json",
        },
      });
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("Received empty text response from Gemini API.");
    }

    const parsed = JSON.parse(responseText);

    return {
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : "Uncategorized",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === "string" && t.trim().length > 0) : [],
      technologies: Array.isArray(parsed.technologies) ? parsed.technologies.filter((t: unknown) => typeof t === "string" && t.trim().length > 0) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    };
  } catch (error) {
    if (options?.throwOnRateLimit && isRateLimitError(error)) {
      throw error;
    }
    console.error("Failed to classify bookmark:", error);
    return {
      category: "Uncategorized",
      tags: [],
      technologies: [],
      summary: "",
    };
  }
}

/**
 * Generates embeddings for a batch of input texts using text-embedding-004.
 * Uses the native multi-content batchEmbedContents endpoint of @google/genai.
 * Maps results strictly by input ID.
 *
 * @param inputs Array of items with id and text to embed
 * @param apiKey User's Gemini API key
 * @param options Optional AI call options
 * @returns Array of BookmarkEmbeddingResult containing id and embedding vector
 */
export async function generateEmbeddingsBatch(
  inputs: BookmarkEmbeddingInput[],
  apiKey: string,
  options?: AiCallOptions
): Promise<BookmarkEmbeddingResult[]> {
  if (!inputs || inputs.length === 0) {
    return [];
  }

  if (!apiKey || !apiKey.trim()) {
    throw new Error("Gemini API key is required for generating embeddings.");
  }

  // Filter out items with empty text, saving them as empty vectors
  const validInputs = inputs.filter((i) => i.text && i.text.trim().length > 0);
  if (validInputs.length === 0) {
    return inputs.map((i) => ({ id: i.id, embedding: [] }));
  }

  const client = getOrCreateGenAIClient(apiKey);
  const contents = validInputs.map((i) => i.text.trim().slice(0, AI_CONFIG.EMBEDDING_MAX_CHARS));

  const response = await globalRateLimiter.execute(async () => {
    return await client.models.embedContent({
      model: "text-embedding-004",
      contents,
    });
  });

  const rawResponse = response as unknown as {
    embeddings?: Array<{ values?: number[] }>;
    embedding?: { values?: number[] };
    values?: number[];
  };

  const embeddingsList = rawResponse.embeddings;
  const resultMap = new Map<string, number[]>();

  if (Array.isArray(embeddingsList) && embeddingsList.length === validInputs.length) {
    for (let i = 0; i < validInputs.length; i++) {
      resultMap.set(validInputs[i].id, embeddingsList[i]?.values ?? []);
    }
  } else if (validInputs.length === 1) {
    // Single item fallback
    const singleValues =
      embeddingsList?.[0]?.values ??
      rawResponse.embedding?.values ??
      rawResponse.values ??
      [];
    resultMap.set(validInputs[0].id, singleValues);
  } else {
    // Fallback if SDK returns fewer embeddings than requested
    for (let i = 0; i < validInputs.length; i++) {
      resultMap.set(validInputs[i].id, embeddingsList?.[i]?.values ?? []);
    }
  }

  return inputs.map((input) => ({
    id: input.id,
    embedding: resultMap.get(input.id) ?? [],
  }));
}

/**
 * Generates a semantic vector embedding for a single text using text-embedding-004.
 * Preserved for backward compatibility.
 */
export async function generateEmbedding(
  text: string,
  apiKey: string,
  options?: AiCallOptions
): Promise<number[]> {
  try {
    if (!apiKey || !apiKey.trim()) {
      throw new Error("Gemini API key is required for generating embeddings.");
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      return [];
    }

    const ai = getOrCreateGenAIClient(apiKey);

    const response = await globalRateLimiter.execute(async () => {
      return await ai.models.embedContent({
        model: "text-embedding-004",
        contents: trimmedText.slice(0, 10000),
      });
    });

    const rawResponse = response as unknown as {
      embedding?: { values?: number[] };
      embeddings?: { values?: number[] }[];
      values?: number[];
    };

    const embeddingValues =
      rawResponse.embeddings?.[0]?.values ??
      rawResponse.embedding?.values ??
      rawResponse.values ??
      [];

    return embeddingValues;
  } catch (error) {
    if (options?.throwOnRateLimit && isRateLimitError(error)) {
      throw error;
    }
    console.error("Failed to generate embedding:", error);
    return [];
  }
}

/**
 * Generates an embedding vector for a user's search query
 * using the Gemini text-embedding-004 model.
 */
export async function embedSearchQuery(
  query: string,
  apiKey: string
): Promise<number[]> {
  return generateEmbedding(query, apiKey);
}
