import Database from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, isNull, sql } from "drizzle-orm";
import { bookmarks, bookmarkAi, bookmarkEmbeddings } from "./schema";
import type { BookmarkMetadata } from "./ai";

export const DB_PATH = "sqlite:bookmarks.db";

let dbInstance: Database | null = null;
let initPromise: Promise<Database> | null = null;

// Drizzle instance holder (allows injection of in-memory instance for testing)
let customDrizzleDb: any = null;
let proxyDrizzleDb: any = null;

export function setDrizzleDb(db: any): void {
  customDrizzleDb = db;
}

export function resetDrizzleDb(): void {
  customDrizzleDb = null;
  proxyDrizzleDb = null;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  domain: string | null;
  created_at: number;
  ai_category?: string | null;
  ai_summary?: string | null;
  ai_tags?: string | null;
  ai_technologies?: string | null;
  similarityScore?: number;
  ai?: {
    summary: string | null;
    category: string | null;
    tags?: string[];
    technologies?: string[];
    processedAt?: number | null;
  } | null;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface BookmarkFolder {
  bookmark_id: string;
  folder_id: string;
}

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE,
    title TEXT,
    description TEXT,
    domain TEXT,
    created_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT,
    parent_id TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS bookmark_folders (
    bookmark_id TEXT,
    folder_id TEXT,
    PRIMARY KEY(bookmark_id, folder_id)
  );`,
  `CREATE TABLE IF NOT EXISTS bookmarkAi (
    bookmarkId TEXT PRIMARY KEY,
    summary TEXT,
    category TEXT,
    tags TEXT,
    technologies TEXT,
    processedAt INTEGER,
    FOREIGN KEY (bookmarkId) REFERENCES bookmarks(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS bookmarkEmbeddings (
    bookmarkId TEXT PRIMARY KEY,
    embedding TEXT,
    FOREIGN KEY (bookmarkId) REFERENCES bookmarks(id) ON DELETE CASCADE
  );`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
    title,
    description,
    url,
    content='bookmarks',
    content_rowid='rowid'
  );`,
  `CREATE TRIGGER IF NOT EXISTS bookmarks_ai AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(rowid, title, description, url)
    VALUES (new.rowid, new.title, new.description, new.url);
  END;`,
  `CREATE TRIGGER IF NOT EXISTS bookmarks_ad AFTER DELETE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, description, url)
    VALUES ('delete', old.rowid, old.title, old.description, old.url);
  END;`,
  `CREATE TRIGGER IF NOT EXISTS bookmarks_au AFTER UPDATE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, description, url)
    VALUES ('delete', old.rowid, old.title, old.description, old.url);
    INSERT INTO bookmarks_fts(rowid, title, description, url)
    VALUES (new.rowid, new.title, new.description, new.url);
  END;`,
];

/**
 * Initializes the SQLite database connection and sets up the relational
 * and virtual search tables along with synchronization triggers.
 */
export async function initializeDatabase(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const db = await Database.load(DB_PATH);

    // Auto-migration: check if bookmarks_fts exists with legacy content_rowid='id'
    try {
      const ftsMeta = await db.select<{ sql: string }[]>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='bookmarks_fts'"
      );
      if (ftsMeta.length > 0 && ftsMeta[0].sql.includes("content_rowid='id'")) {
        await db.execute("DROP TRIGGER IF EXISTS bookmarks_ai;");
        await db.execute("DROP TRIGGER IF EXISTS bookmarks_ad;");
        await db.execute("DROP TRIGGER IF EXISTS bookmarks_au;");
        await db.execute("DROP TABLE IF EXISTS bookmarks_fts;");
      }
    } catch {
      // ignore
    }

    // Always drop and re-create triggers to ensure they use rowid
    try {
      await db.execute("DROP TRIGGER IF EXISTS bookmarks_ai;");
      await db.execute("DROP TRIGGER IF EXISTS bookmarks_ad;");
      await db.execute("DROP TRIGGER IF EXISTS bookmarks_au;");
    } catch {
      // ignore
    }

    for (const sql of SCHEMA_SQL) {
      await db.execute(sql);
    }
    dbInstance = db;
    return db;
  })();

  return initPromise;
}

/**
 * Returns the active Database singleton instance, initializing it if necessary.
 */
export async function getDatabase(): Promise<Database> {
  if (!dbInstance) {
    return initializeDatabase();
  }
  return dbInstance;
}

/**
 * Returns a Drizzle ORM client instance.
 * In production, it connects to Tauri's SQLite plugin via drizzle-orm/sqlite-proxy.
 * In tests, an injected in-memory database (setDrizzleDb) will be returned.
 */
export async function getDrizzleDb(): Promise<any> {
  if (customDrizzleDb) {
    return customDrizzleDb;
  }

  if (proxyDrizzleDb) {
    return proxyDrizzleDb;
  }

  const tauriDb = await getDatabase();
  proxyDrizzleDb = drizzle(async (sql, params, method) => {
    try {
      if (method === "all" || method === "values") {
        const rows = await tauriDb.select<Record<string, unknown>[]>(
          sql,
          params as unknown[]
        );
        return { rows: rows.map((r) => Object.values(r)) };
      }
      if (method === "get") {
        const rows = await tauriDb.select<Record<string, unknown>[]>(
          sql,
          params as unknown[]
        );
        return { rows: rows[0] ? Object.values(rows[0]) : [] };
      }
      if (method === "run") {
        await tauriDb.execute(sql, params as unknown[]);
        return { rows: [] };
      }
      return { rows: [] };
    } catch (err) {
      console.error("Drizzle sqlite-proxy execution error:", err);
      throw err;
    }
  });

  return proxyDrizzleDb;
}

export interface BookmarkAIResultToSave {
  bookmarkId: string;
  metadata: BookmarkMetadata;
  embedding?: number[];
}

/**
 * Saves AI results for a batch of bookmarks in SQLite.
 * Persists metadata and embeddings efficiently with conflict resolution.
 */
export async function saveBookmarkAIResults(
  results: BookmarkAIResultToSave[]
): Promise<void> {
  if (!results || results.length === 0) return;
  const db = await getDrizzleDb();

  for (const item of results) {
    await db
      .insert(bookmarkAi)
      .values({
        bookmarkId: item.bookmarkId,
        summary: item.metadata.summary,
        category: item.metadata.category,
        tags: JSON.stringify(item.metadata.tags || []),
        technologies: JSON.stringify(item.metadata.technologies || []),
        processedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: bookmarkAi.bookmarkId,
        set: {
          summary: item.metadata.summary,
          category: item.metadata.category,
          tags: JSON.stringify(item.metadata.tags || []),
          technologies: JSON.stringify(item.metadata.technologies || []),
          processedAt: Date.now(),
        },
      });

    if (item.embedding && item.embedding.length > 0) {
      await db
        .insert(bookmarkEmbeddings)
        .values({
          bookmarkId: item.bookmarkId,
          embedding: JSON.stringify(item.embedding),
        })
        .onConflictDoUpdate({
          target: bookmarkEmbeddings.bookmarkId,
          set: {
            embedding: JSON.stringify(item.embedding),
          },
        });
    }
  }
}

/**
 * Saves AI-generated metadata and vector embeddings for a bookmark using Drizzle's db.insert().
 * Serializes tags, technologies, and embedding arrays to JSON strings.
 */
export async function saveBookmarkAI(
  bookmarkId: string,
  metadata: BookmarkMetadata,
  embedding: number[]
): Promise<void> {
  await saveBookmarkAIResults([
    {
      bookmarkId,
      metadata,
      embedding,
    },
  ]);
}


/**
 * Preserves successfully generated classification metadata even if embeddings subsequently fail.
 */
export async function saveBookmarkMetadataOnly(
  bookmarkId: string,
  metadata: BookmarkMetadata
): Promise<void> {
  const db = await getDrizzleDb();

  await db
    .insert(bookmarkAi)
    .values({
      bookmarkId,
      summary: metadata.summary,
      category: metadata.category,
      tags: JSON.stringify(metadata.tags || []),
      technologies: JSON.stringify(metadata.technologies || []),
      processedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: bookmarkAi.bookmarkId,
      set: {
        summary: metadata.summary,
        category: metadata.category,
        tags: JSON.stringify(metadata.tags || []),
        technologies: JSON.stringify(metadata.technologies || []),
        processedAt: Date.now(),
      },
    });
}


/**
 * Returns unprocessed bookmarks that do not yet have corresponding records
 * in the bookmarkAi table using a Drizzle LEFT JOIN.
 */
export async function getUnprocessedBookmarks(
  limit: number = 5
): Promise<Bookmark[]> {
  const db = await getDrizzleDb();
  const safeLimit = Math.max(1, limit);

  const rows = await db
    .select({
      id: bookmarks.id,
      url: bookmarks.url,
      title: bookmarks.title,
      description: bookmarks.description,
      domain: bookmarks.domain,
      created_at: bookmarks.createdAt,
    })
    .from(bookmarks)
    .leftJoin(bookmarkAi, eq(bookmarks.id, bookmarkAi.bookmarkId))
    .where(isNull(bookmarkAi.bookmarkId))
    .limit(safeLimit);

  return rows as Bookmark[];
}

/**
 * Returns the total number of unprocessed bookmarks awaiting AI classification/embeddings.
 */
export async function countUnprocessedBookmarks(): Promise<number> {
  const db = await getDrizzleDb();
  const res = await db
    .select({ count: sql<number>`count(*)` })
    .from(bookmarks)
    .leftJoin(bookmarkAi, eq(bookmarks.id, bookmarkAi.bookmarkId))
    .where(isNull(bookmarkAi.bookmarkId));

  return Number(res[0]?.count ?? 0);
}

/**
 * Marks a bookmark as fetch_failed in the bookmarkAi table
 * to prevent the queue from retrying dead, 404, or unreachable URLs indefinitely.
 */
export async function markBookmarkFetchFailed(
  bookmarkId: string,
  errorReason: string
): Promise<void> {
  const db = await getDrizzleDb();

  await db
    .insert(bookmarkAi)
    .values({
      bookmarkId,
      summary: `Fetch failed: ${errorReason}`,
      category: "fetch_failed",
      tags: JSON.stringify([]),
      technologies: JSON.stringify([]),
      processedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: bookmarkAi.bookmarkId,
      set: {
        summary: `Fetch failed: ${errorReason}`,
        category: "fetch_failed",
        tags: JSON.stringify([]),
        technologies: JSON.stringify([]),
        processedAt: Date.now(),
      },
    });
}

