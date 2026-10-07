import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export interface BookmarkContent {
  url: string;
  title: string | null;
  description: string | null;
  rawText: string;
  error?: string | null;
  statusCode?: number | null;
  isUnreachable?: boolean;
}

export interface ParsedHtmlContent {
  title: string | null;
  description: string | null;
  rawText: string;
}

export interface FetchBookmarkOptions {
  timeoutMs?: number;
  maxRedirections?: number;
  userAgent?: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 15000;

function getHttpStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 408:
      return "Request Timeout";
    case 410:
      return "Gone";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    case 504:
      return "Gateway Timeout";
    default:
      return `HTTP ${status}`;
  }
}

/**
 * DOM parsing utility that takes a raw HTML string and extracts:
 * - <title> text (with meta tag fallback)
 * - <meta name="description"> content (with og:description fallback)
 * - Main readable body text with <script>, <style>, <svg>, <nav>, and other boilerplate stripped out.
 *
 * Uses the declarative DOMParser which never executes JavaScript.
 */
export function parseBookmarkHtml(html: string): ParsedHtmlContent {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // 1. Extract <title> text
  let title: string | null = doc.querySelector("title")?.textContent?.trim() || null;
  if (!title) {
    title =
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
      doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content")?.trim() ||
      null;
  }

  // 2. Extract <meta name="description"> content
  const description: string | null =
    doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ||
    doc.querySelector('meta[name="twitter:description"]')?.getAttribute("content")?.trim() ||
    null;

  // 3. Extract readable body text
  const body = doc.body;
  if (!body) {
    return {
      title,
      description,
      rawText: "",
    };
  }

  // Explicitly strip <script>, <style>, <svg>, <nav>, and non-content boilerplate elements
  const tagsToRemove = [
    "script",
    "style",
    "svg",
    "nav",
    "noscript",
    "header",
    "footer",
    "iframe",
    "canvas",
    "audio",
    "video",
    "template",
    "dialog",
  ];

  const elementsToRemove = body.querySelectorAll(tagsToRemove.join(","));
  elementsToRemove.forEach((el) => el.remove());

  // Prioritize primary content container if present
  const primaryLandmark =
    body.querySelector("main") || body.querySelector("article");
  const targetElement =
    primaryLandmark && (primaryLandmark.textContent?.trim().length ?? 0) > 100
      ? primaryLandmark
      : body;

  const rawExtracted = targetElement.textContent || "";

  // Normalize excessive spaces, tabs, and blank lines for token efficiency
  const rawText = rawExtracted
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();

  return {
    title,
    description,
    rawText,
  };
}

/**
 * Fetches the raw HTML content of a bookmark URL using the Tauri HTTP plugin
 * to bypass browser CORS restrictions and extracts its title, description, and raw body text.
 *
 * Fails gracefully on 403, 404, timeouts, or network errors with a structured unreachable status.
 *
 * @param url The target website URL
 * @param options Optional timeout, redirection limit, and user agent
 * @returns Structured BookmarkContent object: { url, title, description, rawText, ... }
 */
export async function fetchBookmarkContent(
  url: string,
  options?: FetchBookmarkOptions
): Promise<BookmarkContent> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
  const maxRedirections = options?.maxRedirections ?? 5;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await tauriFetch(url, {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      connectTimeout: timeoutMs,
      maxRedirections,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle HTTP error statuses (403, 404, 500, etc.) gracefully
    if (!response.ok) {
      const statusText =
        response.statusText || getHttpStatusMessage(response.status);
      return {
        url,
        title: null,
        description: null,
        rawText: "",
        error: `HTTP ${response.status}: ${statusText}`,
        statusCode: response.status,
        isUnreachable: true,
      };
    }

    const rawHtml = await response.text();
    const parsed = parseBookmarkHtml(rawHtml);

    return {
      url,
      title: parsed.title,
      description: parsed.description,
      rawText: parsed.rawText,
      error: null,
      statusCode: response.status,
      isUnreachable: false,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);

    const isTimeout =
      err?.name === "AbortError" ||
      err?.message?.includes("timed out") ||
      controller.signal.aborted;

    const errorMessage = isTimeout
      ? `Request timed out after ${timeoutMs}ms`
      : err?.message || String(err);

    return {
      url,
      title: null,
      description: null,
      rawText: "",
      error: errorMessage,
      statusCode: null,
      isUnreachable: true,
    };
  }
}
