import { GoogleGenAI } from "@google/genai";

export interface BookmarkMetadata {
  category: string;
  tags: string[];
  technologies: string[];
  summary: string;
}

export interface BookmarkClassificationInput {
  title: string;
  description: string;
  rawText: string;
}

export interface AiCallOptions {
  throwOnRateLimit?: boolean;
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
 * Classifies a bookmark's content into developer-oriented categories, tags,
 * technologies, and a short summary using the Gemini 1.5 Flash model.
 *
 * @param content The bookmark's extracted title, description, and raw text
 * @param apiKey The Gemini API key provided by the user
 * @param options Optional configuration (e.g. throwOnRateLimit)
 * @returns Parsed BookmarkMetadata object matching the required interface
 */
export async function classifyBookmark(
  content: { title: string; description: string; rawText: string },
  apiKey: string,
  options?: AiCallOptions
): Promise<BookmarkMetadata> {
  try {
    if (!apiKey || !apiKey.trim()) {
      throw new Error("Gemini API key is required for classification.");
    }

    const ai = new GoogleGenAI({ apiKey: apiKey.trim() });

    const prompt = `Webpage Content to Classify:
Title: ${content.title || "Untitled"}
Description: ${content.description || "No description provided"}
Body Text:
${content.rawText ? content.rawText.slice(0, 15000) : "No body text available"}`;

    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
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
 * Generates a semantic vector embedding for the given text using the
 * Gemini text-embedding-004 model.
 *
 * @param text The input text to embed
 * @param apiKey The Gemini API key provided by the user
 * @param options Optional configuration (e.g. throwOnRateLimit)
 * @returns Array of numbers representing the semantic embedding vector
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

    const ai = new GoogleGenAI({ apiKey: apiKey.trim() });

    const response = await ai.models.embedContent({
      model: "text-embedding-004",
      contents: trimmedText.slice(0, 10000),
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
 *
 * @param query The search query string
 * @param apiKey The Gemini API key provided by the user
 * @returns Array of numbers representing the semantic embedding vector
 */
export async function embedSearchQuery(
  query: string,
  apiKey: string
): Promise<number[]> {
  return generateEmbedding(query, apiKey);
}
