import { inArray, eq } from "drizzle-orm";
import { getDatabase, getDrizzleDb, type Bookmark, type Folder } from "./db";
import { bookmarks, bookmarkAi, bookmarkEmbeddings } from "./schema";
import { embedSearchQuery } from "./ai";
import { normalizeUrl, computeContentHash } from "./url";

export type { Bookmark, Folder };

export interface FolderContents {
  subfolders: Folder[];
  folders: Folder[];
  bookmarks: Bookmark[];
}

/**
 * Normalizes and formats a search query string for SQLite FTS5 prefix matching.
 * Appends a wildcard to support partial typing (e.g., "react" -> "react*"),
 * and safely wraps tokens with punctuation in quotes to prevent FTS5 syntax errors.
 */
export function formatSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }

  // If already ending with wildcard, preserve it
  if (trimmed.endsWith("*")) {
    return trimmed;
  }

  // If query contains special FTS5 punctuation characters, quote the base and append wildcard
  if (/[:/.\-"()]/.test(trimmed)) {
    const escaped = trimmed.replace(/"/g, '""');
    return `"${escaped}"*`;
  }

  return `${trimmed}*`;
}

/**
 * Executes a full-text search against the SQLite bookmarks_fts virtual table using the MATCH operator.
 * Automatically appends a wildcard to the query to support partial typing and ranks results by relevance.
 *
 * @param query The search query string (e.g., "react", "vite")
 * @returns Array of matching bookmarks ordered by relevance rank
 */
export async function searchBookmarks(query: string): Promise<Bookmark[]> {
  const formattedQuery = formatSearchQuery(query);
  if (!formattedQuery) {
    return [];
  }

  const db = await getDatabase();

  return db.select<Bookmark[]>(
    `SELECT b.id, b.url, b.title, b.description, b.domain, b.created_at,
            ai.category as ai_category, ai.summary as ai_summary
     FROM bookmarks b
     JOIN bookmarks_fts ON bookmarks_fts.rowid = b.rowid
     LEFT JOIN bookmarkAi ai ON ai.bookmarkId = b.id
     WHERE bookmarks_fts MATCH ?
     ORDER BY rank`,
    [formattedQuery]
  );
}

/**
 * Returns the most recently added bookmarks, sorted descending by created_at.
 *
 * @param limit Maximum number of bookmarks to return (defaults to 50)
 * @returns Array of recent bookmarks
 */
export async function getRecentBookmarks(limit: number = 50): Promise<Bookmark[]> {
  const db = await getDatabase();
  const safeLimit = Math.max(1, limit);

  return db.select<Bookmark[]>(
    `SELECT b.id, b.url, b.title, b.description, b.domain, b.created_at,
            ai.category as ai_category, ai.summary as ai_summary
     FROM bookmarks b
     LEFT JOIN bookmarkAi ai ON ai.bookmarkId = b.id
     ORDER BY created_at DESC
     LIMIT ?`,
    [safeLimit]
  );
}

/**
 * Returns all subfolders and bookmarks that belong to a specific folder_id
 * by querying the folders table and joining bookmark_folders with bookmarks.
 *
 * @param folderId The ID of the folder (or null / empty string for root items)
 * @returns FolderContents containing subfolders and bookmarks
 */
export async function getFolderContents(
  folderId: string | null = null
): Promise<FolderContents> {
  const db = await getDatabase();

  let subfolders: Folder[];
  let bookmarks: Bookmark[];

  if (!folderId) {
    // Root level folders (parent_id IS NULL)
    subfolders = await db.select<Folder[]>(
      `SELECT id, name, parent_id
       FROM folders
       WHERE parent_id IS NULL
       ORDER BY name ASC`
    );

    // Root level bookmarks (not linked to any folder)
    bookmarks = await db.select<Bookmark[]>(
      `SELECT b.id, b.url, b.title, b.description, b.domain, b.created_at
       FROM bookmarks b
       LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
       WHERE bf.folder_id IS NULL
       ORDER BY b.created_at DESC`
    );
  } else {
    // Subfolders where parent_id matches folderId
    subfolders = await db.select<Folder[]>(
      `SELECT id, name, parent_id
       FROM folders
       WHERE parent_id = ?
       ORDER BY name ASC`,
      [folderId]
    );

    // Bookmarks belonging to folderId via bookmark_folders junction table
    bookmarks = await db.select<Bookmark[]>(
      `SELECT b.id, b.url, b.title, b.description, b.domain, b.created_at
       FROM bookmarks b
       JOIN bookmark_folders bf ON b.id = bf.bookmark_id
       WHERE bf.folder_id = ?
       ORDER BY b.created_at DESC`,
      [folderId]
    );
  }

  return {
    subfolders,
    folders: subfolders,
    bookmarks,
  };
}

/**
 * Returns all folders in the database.
 */
export async function getAllFolders(): Promise<Folder[]> {
  const db = await getDatabase();
  return db.select<Folder[]>(
    `SELECT id, name, parent_id
     FROM folders
     ORDER BY name ASC`
  );
}

export interface FolderNode extends Folder {
  children: FolderNode[];
  bookmarkCount?: number;
}

/**
 * Builds a hierarchical folder tree from all folders in SQLite.
 */
export async function getFolderTree(): Promise<FolderNode[]> {
  const folders = await getAllFolders();
  const db = await getDatabase();

  // Get bookmark counts per folder
  const counts = await db.select<{ folder_id: string; count: number }[]>(
    `SELECT folder_id, COUNT(*) as count FROM bookmark_folders GROUP BY folder_id`
  );
  const countMap = new Map<string, number>();
  for (const c of counts) {
    countMap.set(c.folder_id, c.count);
  }

  const nodeMap = new Map<string, FolderNode>();
  for (const f of folders) {
    nodeMap.set(f.id, {
      ...f,
      children: [],
      bookmarkCount: countMap.get(f.id) ?? 0,
    });
  }

  const rootNodes: FolderNode[] = [];
  for (const f of folders) {
    const node = nodeMap.get(f.id)!;
    if (f.parent_id && nodeMap.has(f.parent_id)) {
      nodeMap.get(f.parent_id)!.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  // Roll up bookmark counts to include subfolder contents
  function rollupCount(node: FolderNode): number {
    let total = node.bookmarkCount ?? 0;
    for (const child of node.children) {
      total += rollupCount(child);
    }
    node.bookmarkCount = total;
    return total;
  }

  for (const root of rootNodes) {
    rollupCount(root);
  }

  return rootNodes;
}

/**
 * Returns all bookmarks that belong to a folder, optionally including subfolders.
 */
export async function getFolderBookmarks(
  folderId: string,
  includeSubfolders: boolean = true
): Promise<Bookmark[]> {
  const db = await getDatabase();

  if (!includeSubfolders) {
    return db.select<Bookmark[]>(
      `SELECT b.id, b.url, b.title, b.description, b.domain, b.created_at,
              ai.category as ai_category, ai.summary as ai_summary
       FROM bookmarks b
       JOIN bookmark_folders bf ON b.id = bf.bookmark_id
       LEFT JOIN bookmarkAi ai ON ai.bookmarkId = b.id
       WHERE bf.folder_id = ?
       ORDER BY b.created_at DESC`,
      [folderId]
    );
  }

  // Recursive CTE to collect folderId and all descendant folder IDs
  return db.select<Bookmark[]>(
    `WITH RECURSIVE folder_hierarchy AS (
       SELECT id FROM folders WHERE id = ?
       UNION ALL
       SELECT f.id FROM folders f
       JOIN folder_hierarchy fh ON f.parent_id = fh.id
     )
     SELECT DISTINCT b.id, b.url, b.title, b.description, b.domain, b.created_at,
            ai.category as ai_category, ai.summary as ai_summary
     FROM bookmarks b
     JOIN bookmark_folders bf ON b.id = bf.bookmark_id
     LEFT JOIN bookmarkAi ai ON ai.bookmarkId = b.id
     WHERE bf.folder_id IN (SELECT id FROM folder_hierarchy)
     ORDER BY b.created_at DESC`,
    [folderId]
  );
}

/**
 * Returns the count of bookmarks that have not yet been processed by the AI layer.
 */
export async function getUnprocessedCount(): Promise<number> {
  const db = await getDatabase();
  const rows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) as count
     FROM bookmarks b
     LEFT JOIN bookmarkAi ai ON ai.bookmarkId = b.id
     WHERE ai.bookmarkId IS NULL`
  );
  return rows[0]?.count ?? 0;
}

/**
 * Retrieves a single bookmark by its ID.
 */
export async function getBookmarkById(id: string): Promise<Bookmark | null> {
  const db = await getDatabase();
  const rows = await db.select<Bookmark[]>(
    `SELECT id, url, title, description, domain, created_at
     FROM bookmarks
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Wipes all bookmarks, folders, and relationships from the database.
 */
export async function clearDatabase(): Promise<void> {
  const db = await getDatabase();
  await db.execute("DELETE FROM bookmark_folders;");
  await db.execute("DELETE FROM bookmarkAi;");
  await db.execute("DELETE FROM bookmarkEmbeddings;");
  await db.execute("DELETE FROM bookmarks;");
  await db.execute("DELETE FROM folders;");
  await db.execute("DELETE FROM bookmarks_fts;");
}

/**
 * Highly optimized mathematical utility that calculates the cosine similarity
 * between two numerical vectors.
 *
 * formula: (A . B) / (||A|| * ||B||)
 * Handles potential zero-magnitude or empty vectors gracefully to prevent division by zero.
 *
 * @param vecA First vector array
 * @param vecB Second vector array
 * @returns Similarity score between -1 and 1 (or 0 for zero-magnitude/empty vectors)
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  const len = Math.min(vecA.length, vecB.length);
  if (len === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SemanticSearchResult extends Bookmark {
  similarityScore: number;
  ai?: {
    summary: string | null;
    category: string | null;
    tags: string[];
    technologies: string[];
    processedAt: number | null;
  } | null;
}

/**
 * Executes a semantic vector search across all bookmark embeddings.
 *
 * 1. Generates an embedding for the user's search query via embedSearchQuery().
 * 2. Fetches all rows from the bookmarkEmbeddings table using Drizzle.
 * 3. Deserializes JSON embeddings and computes cosine similarity scores.
 * 4. Takes the top 15 highest-scoring bookmark IDs.
 * 5. Executes a single Drizzle query joining bookmarks with bookmarkAi using inArray().
 * 6. Maps the similarity scores and AI metadata back, returning results sorted by score descending.
 *
 * @param query The user's semantic search query
 * @param apiKey The user's Gemini API key
 * @returns Array of SemanticSearchResult objects sorted by similarity score descending
 */
export async function semanticSearch(
  query: string,
  apiKey: string
): Promise<SemanticSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  // 1. Embed user search query
  const queryEmbedding = await embedSearchQuery(trimmed, apiKey);
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return [];
  }

  // 2. Fetch all stored embeddings using Drizzle
  const db = await getDrizzleDb();
  const allEmbeddings = await db
    .select({
      bookmarkId: bookmarkEmbeddings.bookmarkId,
      embedding: bookmarkEmbeddings.embedding,
    })
    .from(bookmarkEmbeddings);

  if (!allEmbeddings || allEmbeddings.length === 0) {
    return [];
  }

  // 3. Compute cosine similarity for each embedding
  const scoredItems: { bookmarkId: string; similarityScore: number }[] = [];

  for (const row of allEmbeddings) {
    if (!row.embedding) continue;
    try {
      const vector: number[] = JSON.parse(row.embedding);
      if (Array.isArray(vector) && vector.length > 0) {
        const score = cosineSimilarity(queryEmbedding, vector);
        scoredItems.push({
          bookmarkId: row.bookmarkId,
          similarityScore: score,
        });
      }
    } catch (err) {
      console.error(
        `Failed to parse embedding for bookmark ${row.bookmarkId}:`,
        err
      );
    }
  }

  if (scoredItems.length === 0) {
    return [];
  }

  // 4. Sort descending by similarity score and take top 15
  scoredItems.sort((a, b) => b.similarityScore - a.similarityScore);
  const top15 = scoredItems.slice(0, 15);
  const topIds = top15.map((item) => item.bookmarkId);

  const scoreMap = new Map<string, number>();
  for (const item of top15) {
    scoreMap.set(item.bookmarkId, item.similarityScore);
  }

  // 5. Query bookmarks joined with bookmarkAi using inArray()
  const rows = await db
    .select({
      id: bookmarks.id,
      url: bookmarks.url,
      title: bookmarks.title,
      description: bookmarks.description,
      domain: bookmarks.domain,
      created_at: bookmarks.createdAt,
      aiSummary: bookmarkAi.summary,
      aiCategory: bookmarkAi.category,
      aiTags: bookmarkAi.tags,
      aiTechnologies: bookmarkAi.technologies,
      aiProcessedAt: bookmarkAi.processedAt,
    })
    .from(bookmarks)
    .leftJoin(bookmarkAi, eq(bookmarks.id, bookmarkAi.bookmarkId))
    .where(inArray(bookmarks.id, topIds));

  // 6. Map results and associate similarity scores and parsed AI metadata
  const results: SemanticSearchResult[] = rows.map((r: any) => {
    let tags: string[] = [];
    let technologies: string[] = [];

    if (r.aiTags) {
      try {
        tags = JSON.parse(r.aiTags);
      } catch {
        // ignore
      }
    }
    if (r.aiTechnologies) {
      try {
        technologies = JSON.parse(r.aiTechnologies);
      } catch {
        // ignore
      }
    }

    const hasAi =
      r.aiSummary !== null ||
      r.aiCategory !== null ||
      r.aiProcessedAt !== null;

    return {
      id: r.id,
      url: r.url,
      title: r.title,
      description: r.description,
      domain: r.domain,
      created_at: r.created_at,
      similarityScore: scoreMap.get(r.id) ?? 0,
      ai: hasAi
        ? {
            summary: r.aiSummary,
            category: r.aiCategory,
            tags,
            technologies,
            processedAt: r.aiProcessedAt,
          }
        : null,
    };
  });

  // Sort results matching the top similarity score order
  results.sort((a, b) => b.similarityScore - a.similarityScore);
  return results;
}

export interface DuplicateBookmarkGroup {
  key: string;
  reason: "normalized_url" | "content_hash";
  normalizedUrl?: string;
  contentHash?: string;
  count: number;
  bookmarks: Bookmark[];
}

/**
 * Detects duplicate bookmarks stored in SQLite using Drizzle ORM.
 * Groups bookmarks that share the same normalized URL (ignoring trailing slashes,
 * query tracking parameters, etc.) or identical content hashes (domain + title).
 *
 * @returns Array of DuplicateBookmarkGroup objects representing duplicate clusters
 */
export async function findDuplicateBookmarks(): Promise<DuplicateBookmarkGroup[]> {
  const db = await getDrizzleDb();

  const rows = await db
    .select({
      id: bookmarks.id,
      url: bookmarks.url,
      title: bookmarks.title,
      description: bookmarks.description,
      domain: bookmarks.domain,
      created_at: bookmarks.createdAt,
      aiSummary: bookmarkAi.summary,
      aiCategory: bookmarkAi.category,
    })
    .from(bookmarks)
    .leftJoin(bookmarkAi, eq(bookmarks.id, bookmarkAi.bookmarkId));

  const allBookmarks: Bookmark[] = rows.map((r: any) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    description: r.description,
    domain: r.domain,
    created_at: r.created_at,
    ai_summary: r.aiSummary ?? undefined,
    ai_category: r.aiCategory ?? undefined,
  }));

  const duplicateGroups: DuplicateBookmarkGroup[] = [];
  const handledBookmarkIds = new Set<string>();

  // 1. Group bookmarks by canonical normalized URL
  const urlMap = new Map<string, Bookmark[]>();
  for (const b of allBookmarks) {
    const norm = normalizeUrl(b.url);
    if (!urlMap.has(norm)) {
      urlMap.set(norm, []);
    }
    urlMap.get(norm)!.push(b);
  }

  for (const [normUrl, bList] of urlMap.entries()) {
    if (bList.length > 1) {
      duplicateGroups.push({
        key: normUrl,
        reason: "normalized_url",
        normalizedUrl: normUrl,
        count: bList.length,
        bookmarks: bList,
      });
      for (const b of bList) {
        handledBookmarkIds.add(b.id);
      }
    }
  }

  // 2. Group remaining bookmarks by deterministic content hash
  const hashMap = new Map<string, Bookmark[]>();
  for (const b of allBookmarks) {
    const hash = computeContentHash(b.title, b.domain, b.description);
    if (!hash) continue;
    if (!hashMap.has(hash)) {
      hashMap.set(hash, []);
    }
    hashMap.get(hash)!.push(b);
  }

  for (const [hash, bList] of hashMap.entries()) {
    if (bList.length > 1) {
      // Only include if not every bookmark in this cluster was already reported in URL duplicates
      const allAlreadyGrouped = bList.every((b) => handledBookmarkIds.has(b.id));
      if (!allAlreadyGrouped) {
        duplicateGroups.push({
          key: hash,
          reason: "content_hash",
          contentHash: hash,
          count: bList.length,
          bookmarks: bList,
        });
      }
    }
  }

  // Sort groups with the highest duplicate counts first
  duplicateGroups.sort((a, b) => b.count - a.count);

  return duplicateGroups;
}


