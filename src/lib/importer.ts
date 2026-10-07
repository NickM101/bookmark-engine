import { getDatabase } from "./db";
import { normalizeUrl } from "./url";

export interface ParsedBookmark {
  id: string;
  url: string;
  title: string;
  description: string | null;
  domain: string | null;
  created_at: number;
  folderId: string | null;
}

export interface ParsedFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface FolderTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  children: FolderTreeNode[];
  bookmarks: ParsedBookmark[];
}

export interface ParsedBookmarkData {
  bookmarks: ParsedBookmark[];
  folders: ParsedFolder[];
  bookmarkFolders: { bookmarkId: string; folderId: string }[];
  tree: FolderTreeNode[];
}

export interface ImportResult {
  totalParsed: number;
  bookmarksInserted: number;
  bookmarksUpdated: number;
  duplicatesIgnored: number;
  foldersCreated: number;
  linksCreated: number;
  errors: string[];
}

/**
 * Extracts a normalized hostname/domain from a URL string.
 */
export function extractDomain(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Sanitizes Netscape bookmark HTML by removing legacy unclosed <p> tags
 * which corrupt HTML5 DOM parsing of <DL>/<DT> hierarchies.
 */
export function sanitizeNetscapeHtml(html: string): string {
  return html.replace(/<p\b[^>]*>/gi, "").replace(/<\/p>/gi, "");
}

/**
 * Builds a hierarchical tree from flat lists of folders and bookmarks.
 */
export function buildFolderTree(
  folders: ParsedFolder[],
  bookmarks: ParsedBookmark[]
): FolderTreeNode[] {
  const nodeMap = new Map<string, FolderTreeNode>();
  const rootNodes: FolderTreeNode[] = [];

  for (const f of folders) {
    nodeMap.set(f.id, {
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      children: [],
      bookmarks: [],
    });
  }

  for (const b of bookmarks) {
    if (b.folderId && nodeMap.has(b.folderId)) {
      nodeMap.get(b.folderId)!.bookmarks.push(b);
    }
  }

  for (const f of folders) {
    const node = nodeMap.get(f.id)!;
    if (f.parentId && nodeMap.has(f.parentId)) {
      nodeMap.get(f.parentId)!.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  return rootNodes;
}

/**
 * Parses an exported browser bookmark HTML string (Netscape Bookmark File Format)
 * using the browser-native DOMParser, recursively extracting folders, bookmarks,
 * descriptions, and timestamps while maintaining the full folder hierarchy.
 */
export function parseNetscapeBookmarks(htmlContent: string): ParsedBookmarkData {
  const sanitized = sanitizeNetscapeHtml(htmlContent);
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitized, "text/html");

  const bookmarks: ParsedBookmark[] = [];
  const folders: ParsedFolder[] = [];
  const bookmarkFolders: { bookmarkId: string; folderId: string }[] = [];

  const visitedElements = new Set<Element>();

  /**
   * Recursively processes a <DL> list representing folder contents.
   *
   * In Netscape format:
   * - <DL> represents a list of items (a folder's contents).
   * - <DT><H3> represents a folder name.
   * - <DT><A href="..."> represents a bookmark.
   * - <DD> contains an optional description for the preceding item.
   */
  function processDL(dlElement: Element, currentFolderId: string | null) {
    if (visitedElements.has(dlElement)) {
      return;
    }
    visitedElements.add(dlElement);

    const children = Array.from(dlElement.children);
    let i = 0;

    while (i < children.length) {
      const child = children[i];
      i++;

      if (visitedElements.has(child)) {
        continue;
      }

      if (child.tagName === "DT") {
        visitedElements.add(child);

        const h3 = child.querySelector(":scope > h3") || child.querySelector("h3");
        const a = child.querySelector(":scope > a") || child.querySelector("a");

        if (h3) {
          // Folder item
          const folderId = crypto.randomUUID();
          const folderName = h3.textContent?.trim() || "Untitled Folder";

          folders.push({
            id: folderId,
            name: folderName,
            parentId: currentFolderId,
          });

          // Check if there is an associated child or sibling <DL>
          let subDL: Element | null = child.querySelector(":scope > dl") || child.querySelector("dl");
          if (!subDL) {
            // In Netscape outputs, <DL> can be a sibling immediately following <DT> or <DD>
            let candidate: Element | null = child.nextElementSibling;
            while (candidate && candidate.tagName !== "DT" && candidate.tagName !== "H3") {
              if (candidate.tagName === "DL") {
                subDL = candidate;
                break;
              }
              candidate = candidate.nextElementSibling;
            }
          }

          if (subDL) {
            processDL(subDL, folderId);
          }
        } else if (a) {
          // Bookmark item
          const href = a.getAttribute("href")?.trim();
          if (href && !href.toLowerCase().startsWith("javascript:")) {
            const normalizedUrl = normalizeUrl(href);
            const bookmarkId = crypto.randomUUID();
            const title = a.textContent?.trim() || normalizedUrl;

            // Extract description from child <DD> or next sibling <DD>
            let description: string | null = null;
            const childDD = child.querySelector("dd");
            if (childDD) {
              description = childDD.textContent?.trim() || null;
            } else if (child.nextElementSibling && child.nextElementSibling.tagName === "DD") {
              const siblingDD = child.nextElementSibling;
              visitedElements.add(siblingDD);
              description = siblingDD.textContent?.trim() || null;
            }

            // Extract ADD_DATE timestamp
            const addDateAttr = a.getAttribute("add_date") || a.getAttribute("ADD_DATE");
            let createdAt = Date.now();
            if (addDateAttr) {
              const parsedSec = parseInt(addDateAttr, 10);
              if (!isNaN(parsedSec) && parsedSec > 0) {
                createdAt = parsedSec < 10000000000 ? parsedSec * 1000 : parsedSec;
              }
            }

            const domain = extractDomain(normalizedUrl);

            bookmarks.push({
              id: bookmarkId,
              url: normalizedUrl,
              title,
              description,
              domain,
              created_at: createdAt,
              folderId: currentFolderId,
            });

            if (currentFolderId) {
              bookmarkFolders.push({
                bookmarkId,
                folderId: currentFolderId,
              });
            }
          }
        }
      } else if (child.tagName === "DL") {
        processDL(child, currentFolderId);
      }
    }
  }

  // Find root <DL> elements in document
  const allDLs = Array.from(doc.querySelectorAll("dl"));
  const topLevelDLs = allDLs.filter((dl) => !dl.parentElement?.closest("dl"));

  for (const rootDL of topLevelDLs) {
    processDL(rootDL, null);
  }

  const tree = buildFolderTree(folders, bookmarks);

  return { bookmarks, folders, bookmarkFolders, tree };
}

export interface ImportProgress {
  stage: "parsing" | "folders" | "bookmarks" | "links" | "committing" | "done";
  current: number;
  total: number;
  percent: number;
  message: string;
}

export type OnImportProgress = (progress: ImportProgress) => void;

/**
 * Ingests a Netscape Bookmark HTML export into SQLite via the Tauri SQL plugin.
 * Handles duplicate URLs gracefully with `INSERT OR IGNORE`, preserves folder hierarchies,
 * and batch-inserts mappings into the `bookmark_folders` table while reporting progress.
 */
export async function importBookmarks(
  htmlContent: string,
  onProgress?: OnImportProgress
): Promise<ImportResult> {
  onProgress?.({
    stage: "parsing",
    current: 0,
    total: 100,
    percent: 10,
    message: "Parsing bookmark HTML structure...",
  });

  const parsed = parseNetscapeBookmarks(htmlContent);
  const db = await getDatabase();

  let bookmarksInserted = 0;
  let duplicatesIgnored = 0;
  let foldersCreated = 0;
  let linksCreated = 0;
  const errors: string[] = [];

  // 1. Fetch all existing URLs and folders once to resolve canonical IDs without per-row queries
  const urlToCanonicalId = new Map<string, string>();
  try {
    const existingBookmarks = await db.select<{ id: string; url: string }[]>(
      "SELECT id, url FROM bookmarks"
    );
    for (const eb of existingBookmarks) {
      urlToCanonicalId.set(eb.url, eb.id);
      urlToCanonicalId.set(normalizeUrl(eb.url), eb.id);
    }
  } catch (err) {
    errors.push(`Failed to prefetch existing bookmarks: ${String(err)}`);
  }

  // Map of existing folders key (name + "::" + (parentId ?? "ROOT")) to folder ID
  const existingFolderMap = new Map<string, string>();
  try {
    const existingFolders = await db.select<{ id: string; name: string; parent_id: string | null }[]>(
      "SELECT id, name, parent_id FROM folders"
    );
    for (const ef of existingFolders) {
      const key = `${ef.name}::${ef.parent_id ?? "ROOT"}`;
      existingFolderMap.set(key, ef.id);
    }
  } catch (err) {
    errors.push(`Failed to prefetch existing folders: ${String(err)}`);
  }

  // 2. Remap parsed folder IDs to existing folder IDs if already present to deduplicate folders
  const folderIdRemap = new Map<string, string>();
  const foldersToInsert: ParsedFolder[] = [];

  for (const folder of parsed.folders) {
    const remappedParentId = folder.parentId ? (folderIdRemap.get(folder.parentId) ?? folder.parentId) : null;
    const folderKey = `${folder.name}::${remappedParentId ?? "ROOT"}`;

    if (existingFolderMap.has(folderKey)) {
      const canonicalFolderId = existingFolderMap.get(folderKey)!;
      folderIdRemap.set(folder.id, canonicalFolderId);
    } else {
      folderIdRemap.set(folder.id, folder.id);
      existingFolderMap.set(folderKey, folder.id);
      foldersToInsert.push({
        id: folder.id,
        name: folder.name,
        parentId: remappedParentId,
      });
    }
  }

  // 3. Identify unique bookmarks to insert vs existing duplicates
  const bookmarksToInsert: ParsedBookmark[] = [];
  for (const bookmark of parsed.bookmarks) {
    const normalizedUrl = normalizeUrl(bookmark.url);
    bookmark.url = normalizedUrl;
    bookmark.domain = extractDomain(normalizedUrl) ?? bookmark.domain;

    if (urlToCanonicalId.has(normalizedUrl)) {
      duplicatesIgnored++;
    } else {
      urlToCanonicalId.set(normalizedUrl, bookmark.id);
      bookmarksToInsert.push(bookmark);
    }
  }

    // 4. Batch insert folders in chunks of 50
    const FOLDER_CHUNK_SIZE = 50;
    const totalFolders = foldersToInsert.length;

    for (let i = 0; i < totalFolders; i += FOLDER_CHUNK_SIZE) {
      const chunk = foldersToInsert.slice(i, i + FOLDER_CHUNK_SIZE);
      const rowPlaceholders = chunk.map(() => "(?, ?, ?)").join(", ");
      const params: unknown[] = [];

      for (const folder of chunk) {
        params.push(folder.id, folder.name, folder.parentId);
      }

      try {
        await db.execute(
          `INSERT OR IGNORE INTO folders (id, name, parent_id) VALUES ${rowPlaceholders}`,
          params
        );
        foldersCreated += chunk.length;
        onProgress?.({
          stage: "folders",
          current: foldersCreated,
          total: totalFolders,
          percent: Math.min(25, Math.round((foldersCreated / Math.max(1, totalFolders)) * 25)),
          message: `Ingesting folders (${foldersCreated}/${totalFolders})...`,
        });
      } catch (err) {
        console.error("Folders chunk error:", err);
        errors.push(`Folders chunk error: ${String(err)}`);
      }
    }

    // 5. Batch insert bookmarks in chunks of 50
    const BOOKMARK_CHUNK_SIZE = 50;
    const totalBookmarks = bookmarksToInsert.length;

    for (let i = 0; i < totalBookmarks; i += BOOKMARK_CHUNK_SIZE) {
      const chunk = bookmarksToInsert.slice(i, i + BOOKMARK_CHUNK_SIZE);
      const rowPlaceholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const params: unknown[] = [];

      for (const bm of chunk) {
        params.push(
          bm.id,
          bm.url,
          bm.title,
          bm.description,
          bm.domain,
          bm.created_at
        );
      }

      try {
        await db.execute(
          `INSERT OR IGNORE INTO bookmarks (id, url, title, description, domain, created_at) VALUES ${rowPlaceholders}`,
          params
        );
        bookmarksInserted += chunk.length;
        const bmPercent =
          25 + Math.round((bookmarksInserted / Math.max(1, totalBookmarks)) * 50);
        onProgress?.({
          stage: "bookmarks",
          current: bookmarksInserted,
          total: totalBookmarks,
          percent: Math.min(75, bmPercent),
          message: `Ingesting bookmarks (${bookmarksInserted}/${totalBookmarks})...`,
        });
      } catch (err) {
        console.error("Bookmarks chunk error:", err);
        errors.push(`Bookmarks chunk error: ${String(err)}`);
      }
    }

    // 6. Batch insert bookmark_folders links in chunks of 100
    const linksToInsert: { bookmarkId: string; folderId: string }[] = [];
    const seenLinks = new Set<string>();

    for (const bm of parsed.bookmarks) {
      if (bm.folderId) {
        const canonicalBookmarkId = urlToCanonicalId.get(bm.url) || bm.id;
        const canonicalFolderId = folderIdRemap.get(bm.folderId) || bm.folderId;
        const key = `${canonicalBookmarkId}:${canonicalFolderId}`;
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          linksToInsert.push({ bookmarkId: canonicalBookmarkId, folderId: canonicalFolderId });
        }
      }
    }

    const LINK_CHUNK_SIZE = 100;
    const totalLinks = linksToInsert.length;

    for (let i = 0; i < totalLinks; i += LINK_CHUNK_SIZE) {
      const chunk = linksToInsert.slice(i, i + LINK_CHUNK_SIZE);
      const rowPlaceholders = chunk.map(() => "(?, ?)").join(", ");
      const params: unknown[] = [];

      for (const link of chunk) {
        params.push(link.bookmarkId, link.folderId);
      }

      try {
        await db.execute(
          `INSERT OR IGNORE INTO bookmark_folders (bookmark_id, folder_id) VALUES ${rowPlaceholders}`,
          params
        );
        linksCreated += chunk.length;
        const linkPercent =
          75 + Math.round((linksCreated / Math.max(1, totalLinks)) * 20);
        onProgress?.({
          stage: "links",
          current: linksCreated,
          total: totalLinks,
          percent: Math.min(95, linkPercent),
          message: `Linking folder hierarchies (${linksCreated}/${totalLinks})...`,
        });
      } catch (err) {
        console.error("Links chunk error:", err);
        errors.push(`Links chunk error: ${String(err)}`);
      }
    }

    onProgress?.({
      stage: "done",
      current: bookmarksInserted,
      total: totalBookmarks,
      percent: 100,
      message: `Successfully imported ${bookmarksInserted} bookmarks!`,
    });

  return {
    totalParsed: parsed.bookmarks.length,
    bookmarksInserted,
    bookmarksUpdated: duplicatesIgnored,
    duplicatesIgnored,
    foldersCreated,
    linksCreated,
    errors,
  };
}
