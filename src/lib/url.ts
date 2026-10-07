/**
 * Set of known analytics, advertising, and marketing tracking query parameters
 * that should be stripped during URL normalization.
 */
const TRACKING_PARAMS = new Set([
  // Social & Referral
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "fbclid",
  "igshid",
  "twclid",
  "si", // YouTube share tracking
  "spm", // Alibaba / AliExpress tracking

  // Google & Search Ads
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",

  // Microsoft / Bing & Others
  "msclkid",
  "yclid",
  "zanpid",

  // Email Marketing (MailChimp, HubSpot, etc.)
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "sc_channel",
  "sc_campaign",
]);

/**
 * Non-content anchor hashes (jump links, UI elements, tracking fragments)
 * that should be stripped rather than treated as documentation deep-links.
 */
const NON_DOC_HASHES = new Set([
  "",
  "#",
  "#top",
  "#header",
  "#nav",
  "#navigation",
  "#main",
  "#main-content",
  "#content",
  "#skip",
  "#skip-to-content",
  "#skip-content",
  "#comments",
  "#comment",
  "#respond",
  "#reply",
  "#share",
  "#social",
  "#footer",
  "#sidebar",
  "#print",
  "#_=_", // Facebook OAuth/redirect artifact
]);

/**
 * Checks if a query parameter key is a tracking parameter.
 */
function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("utm_")) {
    return true;
  }
  return TRACKING_PARAMS.has(lower);
}

/**
 * Determines whether a URL hash represents a meaningful documentation section deep-link
 * (e.g. #installation, #getting-started, #api-reference, #L10-L20) or a generic UI / tracking jump link.
 *
 * @param hash The URL fragment (including leading '#')
 * @returns true if the hash should be preserved as a section heading anchor
 */
export function isDocumentationDeepLink(hash: string): boolean {
  if (!hash || hash === "#") {
    return false;
  }

  const lower = hash.toLowerCase();

  // Strip Chrome Scroll-To-Text Fragment (#:~:text=...)
  if (lower.startsWith("#:~:text=")) {
    return false;
  }

  // Strip tracking in hash (e.g. #utm_source=..., #xtor=...)
  if (lower.includes("utm_") || lower.includes("xtor=")) {
    return false;
  }

  // Strip generic UI jump targets
  if (NON_DOC_HASHES.has(lower)) {
    return false;
  }

  // Strip SPA query artifacts in hash if they contain key=value (unless code line reference like #L1-L10)
  if (hash.includes("=") && !/^#L\d+/i.test(hash)) {
    return false;
  }

  // Valid markdown section heading pattern: alphanumeric, hyphens, underscores, dots, colons
  // Examples: #installation, #getting-started, #api-reference, #quick_start, #section-2.1, #L42-L55
  return /^#[a-zA-Z0-9_\-.:]+$/.test(hash);
}

/**
 * Normalizes a URL for deduplication and canonical storage:
 * - Strips marketing & analytics tracking parameters (utm_*, ref, fbclid, gclid, etc.)
 * - Normalizes trailing slashes (e.g., example.com/foo/ -> example.com/foo)
 * - Normalizes protocol and hostname to lowercase
 * - Strips standard default ports (:80 for http, :443 for https)
 * - Strips generic UI/tracking hash fragments while preserving documentation section deep-links
 * - Sorts remaining query parameters alphabetically
 *
 * @param rawUrl The raw URL string to normalize
 * @returns The clean, normalized URL string
 */
export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }

  // Detect whether the input contains an explicit scheme (e.g., http://, https://)
  const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);

  let url: URL;
  try {
    url = new URL(hasProtocol ? trimmed : `https://${trimmed}`);
  } catch {
    // If invalid URL, return trimmed string fallback
    return trimmed;
  }

  // 1. Lowercase protocol and hostname
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  // 2. Strip default ports
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  // 3. Strip tracking parameters from search params
  const keysToDelete: string[] = [];
  url.searchParams.forEach((_, key) => {
    if (isTrackingParam(key)) {
      keysToDelete.push(key);
    }
  });
  for (const key of keysToDelete) {
    url.searchParams.delete(key);
  }

  // Sort remaining query parameters alphabetically
  url.searchParams.sort();

  // 4. Normalize pathname: collapse consecutive slashes and strip trailing slashes
  let cleanPath = url.pathname.replace(/\/{2,}/g, "/");
  if (cleanPath.length > 1 && cleanPath.endsWith("/")) {
    cleanPath = cleanPath.slice(0, -1);
  } else if (cleanPath === "/") {
    cleanPath = "";
  }

  // 5. Hash fragment normalization: preserve documentation deep-links, strip generic anchors
  let cleanHash = "";
  if (url.hash && isDocumentationDeepLink(url.hash)) {
    cleanHash = url.hash;
  }

  // 6. Build the normalized query string
  const cleanSearch = url.searchParams.toString()
    ? `?${url.searchParams.toString()}`
    : "";

  // 7. Reconstruct canonical URL (preserving omission of protocol if raw input omitted it)
  if (hasProtocol) {
    return `${url.protocol}//${url.host}${cleanPath}${cleanSearch}${cleanHash}`;
  }

  return `${url.host}${cleanPath}${cleanSearch}${cleanHash}`;
}

/**
 * Computes a fast deterministic 64-bit content hash from a bookmark's title, domain,
 * and optional description to detect duplicate bookmarks with different URLs
 * that point to the same content.
 *
 * @param title The bookmark's title
 * @param domain The bookmark's domain
 * @param description The bookmark's description
 * @returns Hex string hash representing the content
 */
export function computeContentHash(
  title: string | null | undefined,
  domain: string | null | undefined,
  description?: string | null | undefined
): string {
  const normDomain = (domain || "").toLowerCase().trim();
  const normTitle = (title || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "");

  if (!normTitle && !normDomain) {
    return "";
  }

  const normDesc = (description || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 100);

  // FNV-1a 64-bit hash
  const str = `${normDomain}|${normTitle}|${normDesc}`;
  let h1 = 0xdeadbeef,
    h2 = 0x41c64e6d;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
