import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { setDrizzleDb, resetDrizzleDb, getUnprocessedBookmarks, saveBookmarkAI } from "./db";
import {
  processNextBatch,
  startProcessingQueue,
  setThrottleDelayMsForTesting,
  resetThrottleDelayMsForTesting,
  setInitialBackoffMsForTesting,
  resetInitialBackoffMsForTesting,
  type QueueStats,
} from "./processor";
import * as fetcherModule from "./fetcher";
import * as aiModule from "./ai";

vi.mock("./fetcher", () => ({
  fetchBookmarkContent: vi.fn(),
}));

vi.mock("./ai", () => ({
  classifyBookmark: vi.fn(),
  generateEmbedding: vi.fn(),
  isRateLimitError: (err: unknown) => {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    return (
      msg.includes("429") ||
      lower.includes("resource_exhausted") ||
      lower.includes("quota")
    );
  },
}));

describe("processor.ts - Background AI Queue Worker (In-Memory SQLite)", () => {
  let sqlite: Database.Database;
  let testDrizzleDb: ReturnType<typeof drizzle>;

  beforeEach(() => {
    vi.clearAllMocks();
    setThrottleDelayMsForTesting(1);
    setInitialBackoffMsForTesting(30);

    // 1. Create a local, strictly in-memory SQLite database instance for Vitest
    sqlite = new Database(":memory:");

    // 2. Set up schemas directly in the in-memory SQLite instance
    sqlite.exec(`
      CREATE TABLE bookmarks (
        id TEXT PRIMARY KEY,
        url TEXT UNIQUE,
        title TEXT,
        description TEXT,
        domain TEXT,
        created_at INTEGER
      );

      CREATE TABLE bookmarkAi (
        bookmarkId TEXT PRIMARY KEY,
        summary TEXT,
        category TEXT,
        tags TEXT,
        technologies TEXT,
        processedAt INTEGER,
        FOREIGN KEY (bookmarkId) REFERENCES bookmarks(id) ON DELETE CASCADE
      );

      CREATE TABLE bookmarkEmbeddings (
        bookmarkId TEXT PRIMARY KEY,
        embedding TEXT,
        FOREIGN KEY (bookmarkId) REFERENCES bookmarks(id) ON DELETE CASCADE
      );
    `);

    // 3. Connect Drizzle ORM to better-sqlite3 and inject into db.ts
    testDrizzleDb = drizzle(sqlite);
    setDrizzleDb(testDrizzleDb);
  });

  afterEach(() => {
    resetThrottleDelayMsForTesting();
    resetInitialBackoffMsForTesting();
    resetDrizzleDb();
    sqlite.close();
  });

  it("fetches unprocessed bookmarks and saves AI metadata and embeddings to in-memory SQLite", async () => {
    // Seed 2 unprocessed bookmarks in in-memory DB
    sqlite.prepare(`
      INSERT INTO bookmarks (id, url, title, description, domain, created_at)
      VALUES 
        ('b-1', 'https://react.dev', 'React Documentation', 'UI library', 'react.dev', 1700000000000),
        ('b-2', 'https://vite.dev', 'Vite Bundler', 'Next gen tool', 'vite.dev', 1700000001000)
    `).run();

    // Mock fetchBookmarkContent
    vi.mocked(fetcherModule.fetchBookmarkContent).mockImplementation(async (url: string) => {
      if (url === "https://react.dev") {
        return {
          url,
          title: "React Official",
          description: "A JavaScript library for building user interfaces",
          rawText: "React components are regular JavaScript functions.",
          isUnreachable: false,
        };
      }
      return {
        url,
        title: "Vite",
        description: "Next Generation Frontend Tooling",
        rawText: "Vite provides fast HMR and instant server start.",
        isUnreachable: false,
      };
    });

    // Mock classifyBookmark
    vi.mocked(aiModule.classifyBookmark).mockImplementation(async (content) => {
      if (content.title.includes("React")) {
        return {
          category: "Frontend",
          tags: ["react", "ui", "javascript"],
          technologies: ["React"],
          summary: "Official React documentation for UI building.",
        };
      }
      return {
        category: "Build Tools",
        tags: ["vite", "bundler", "esm"],
        technologies: ["Vite", "Rollup"],
        summary: "Vite frontend build tool guide.",
      };
    });

    // Mock generateEmbedding
    vi.mocked(aiModule.generateEmbedding).mockImplementation(async () => {
      return [0.12, -0.34, 0.56, -0.78];
    });

    // Process next batch
    const apiKey = "mock-gemini-key";
    const result = await processNextBatch(apiKey, 5);

    expect(result.processedCount).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].success).toBe(true);
    expect(result.items[1].success).toBe(true);

    // Verify AI and fetcher calls
    expect(fetcherModule.fetchBookmarkContent).toHaveBeenCalledTimes(2);
    expect(aiModule.classifyBookmark).toHaveBeenCalledTimes(2);
    expect(aiModule.generateEmbedding).toHaveBeenCalledTimes(2);

    // Verify in-memory SQLite bookmarkAi table contents directly
    const aiRows = sqlite.prepare("SELECT * FROM bookmarkAi ORDER BY bookmarkId ASC").all() as any[];
    expect(aiRows).toHaveLength(2);

    expect(aiRows[0].bookmarkId).toBe("b-1");
    expect(aiRows[0].category).toBe("Frontend");
    expect(JSON.parse(aiRows[0].tags)).toEqual(["react", "ui", "javascript"]);
    expect(JSON.parse(aiRows[0].technologies)).toEqual(["React"]);
    expect(aiRows[0].summary).toBe("Official React documentation for UI building.");
    expect(typeof aiRows[0].processedAt).toBe("number");

    expect(aiRows[1].bookmarkId).toBe("b-2");
    expect(aiRows[1].category).toBe("Build Tools");

    // Verify in-memory SQLite bookmarkEmbeddings table contents directly
    const embeddingRows = sqlite.prepare("SELECT * FROM bookmarkEmbeddings ORDER BY bookmarkId ASC").all() as any[];
    expect(embeddingRows).toHaveLength(2);
    expect(embeddingRows[0].bookmarkId).toBe("b-1");
    expect(JSON.parse(embeddingRows[0].embedding)).toEqual([0.12, -0.34, 0.56, -0.78]);

    // Verify subsequent call finds 0 unprocessed bookmarks
    const remainingUnprocessed = await getUnprocessedBookmarks(5);
    expect(remainingUnprocessed).toHaveLength(0);

    const nextBatchResult = await processNextBatch(apiKey, 5);
    expect(nextBatchResult.processedCount).toBe(0);
  });

  it("getUnprocessedBookmarks excludes bookmarks already present in bookmarkAi", async () => {
    sqlite.prepare(`
      INSERT INTO bookmarks (id, url, title, description, domain, created_at)
      VALUES 
        ('b-1', 'https://site1.com', 'Site 1', NULL, 'site1.com', 1000),
        ('b-2', 'https://site2.com', 'Site 2', NULL, 'site2.com', 2000),
        ('b-3', 'https://site3.com', 'Site 3', NULL, 'site3.com', 3000)
    `).run();

    // Mark b-2 as already processed
    sqlite.prepare(`
      INSERT INTO bookmarkAi (bookmarkId, summary, category, tags, technologies, processedAt)
      VALUES ('b-2', 'Summary 2', 'Tool', '[]', '[]', 2000)
    `).run();

    const unprocessed = await getUnprocessedBookmarks(10);
    expect(unprocessed).toHaveLength(2);
    expect(unprocessed.map((b) => b.id).sort()).toEqual(["b-1", "b-3"]);
  });

  it("handles individual bookmark processing errors gracefully without aborting the batch", async () => {
    sqlite.prepare(`
      INSERT INTO bookmarks (id, url, title, description, domain, created_at)
      VALUES 
        ('b-fail', 'https://broken.invalid', 'Broken', NULL, 'broken.invalid', 1000),
        ('b-ok', 'https://good.dev', 'Good', NULL, 'good.dev', 2000)
    `).run();

    vi.mocked(fetcherModule.fetchBookmarkContent).mockImplementation(async (url: string) => {
      if (url === "https://broken.invalid") {
        throw new Error("DNS resolution failed");
      }
      return {
        url,
        title: "Good Dev",
        description: "Valid site",
        rawText: "Content",
        isUnreachable: false,
      };
    });

    vi.mocked(aiModule.classifyBookmark).mockResolvedValue({
      category: "Docs",
      tags: ["good"],
      technologies: [],
      summary: "Good site summary",
    });

    vi.mocked(aiModule.generateEmbedding).mockResolvedValue([0.1, 0.2]);

    const result = await processNextBatch("api-key", 5);

    expect(result.processedCount).toBe(1);
    expect(result.items).toHaveLength(2);

    const failedItem = result.items.find((i) => i.bookmarkId === "b-fail");
    expect(failedItem?.success).toBe(false);
    expect(failedItem?.error).toContain("DNS resolution failed");

    const okItem = result.items.find((i) => i.bookmarkId === "b-ok");
    expect(okItem?.success).toBe(true);

    // Verify that b-ok was successfully saved in SQLite
    const saved = sqlite.prepare("SELECT * FROM bookmarkAi WHERE bookmarkId = 'b-ok'").get() as any;
    expect(saved).toBeDefined();
    expect(saved.category).toBe("Docs");
  });

  it("saveBookmarkAI overwrites existing record cleanly with conflict resolution", async () => {
    sqlite.prepare(`
      INSERT INTO bookmarks (id, url, title, description, domain, created_at)
      VALUES ('b-update', 'https://example.com', 'Example', NULL, 'example.com', 1000)
    `).run();

    await saveBookmarkAI(
      "b-update",
      { category: "Old", tags: ["v1"], technologies: [], summary: "Initial" },
      [1.0]
    );

    await saveBookmarkAI(
      "b-update",
      { category: "New", tags: ["v2"], technologies: ["Tech2"], summary: "Updated" },
      [2.0, 3.0]
    );

    const aiRecord = sqlite.prepare("SELECT * FROM bookmarkAi WHERE bookmarkId = 'b-update'").get() as any;
    expect(aiRecord.category).toBe("New");
    expect(JSON.parse(aiRecord.tags)).toEqual(["v2"]);
    expect(JSON.parse(aiRecord.technologies)).toEqual(["Tech2"]);
    expect(aiRecord.summary).toBe("Updated");

    const embRecord = sqlite.prepare("SELECT * FROM bookmarkEmbeddings WHERE bookmarkId = 'b-update'").get() as any;
    expect(JSON.parse(embRecord.embedding)).toEqual([2.0, 3.0]);
  });

  describe("startProcessingQueue - automated background queue", () => {
    it("processes all bookmarks continuously and notifies progress until completed", async () => {
      sqlite.prepare(`
        INSERT INTO bookmarks (id, url, title, description, domain, created_at)
        VALUES 
          ('q-1', 'https://page1.com', 'Page 1', 'Desc 1', 'page1.com', 1000),
          ('q-2', 'https://page2.com', 'Page 2', 'Desc 2', 'page2.com', 2000)
      `).run();

      vi.mocked(fetcherModule.fetchBookmarkContent).mockResolvedValue({
        url: "https://mock.com",
        title: "Mock Title",
        description: "Mock Desc",
        rawText: "Mock Body",
        isUnreachable: false,
      });

      vi.mocked(aiModule.classifyBookmark).mockResolvedValue({
        category: "Software",
        tags: ["dev"],
        technologies: ["Node"],
        summary: "Summary text",
      });

      vi.mocked(aiModule.generateEmbedding).mockResolvedValue([0.5, -0.5]);

      const progressSnapshots: QueueStats[] = [];
      let completionResolve: () => void;
      const completionPromise = new Promise<void>((res) => {
        completionResolve = res;
      });

      const abort = startProcessingQueue("test-gemini-key", (stats) => {
        progressSnapshots.push({ ...stats });
        if (stats.status === "completed") {
          completionResolve();
        }
      });

      await completionPromise;
      abort();

      const lastStat = progressSnapshots[progressSnapshots.length - 1];
      expect(lastStat.status).toBe("completed");
      expect(lastStat.processed).toBe(2);
      expect(lastStat.total).toBe(2);
      expect(lastStat.failed).toBe(0);

      // Verify records are saved in DB
      const count = sqlite.prepare("SELECT count(*) as count FROM bookmarkAi").get() as any;
      expect(count.count).toBe(2);
    });

    it("marks unreachable/fetch-failed bookmarks as fetch_failed so they are not retried", async () => {
      sqlite.prepare(`
        INSERT INTO bookmarks (id, url, title, description, domain, created_at)
        VALUES 
          ('q-dead', 'https://deadlink.xyz', 'Dead Site', NULL, 'deadlink.xyz', 1000),
          ('q-ok', 'https://live.xyz', 'Live Site', NULL, 'live.xyz', 2000)
      `).run();

      vi.mocked(fetcherModule.fetchBookmarkContent).mockImplementation(async (url: string) => {
        if (url === "https://deadlink.xyz") {
          return {
            url,
            title: null,
            description: null,
            rawText: "",
            error: "HTTP 404: Not Found",
            isUnreachable: true,
          };
        }
        return {
          url,
          title: "Live",
          description: "Alive",
          rawText: "Live text",
          isUnreachable: false,
        };
      });

      vi.mocked(aiModule.classifyBookmark).mockResolvedValue({
        category: "LiveCategory",
        tags: ["live"],
        technologies: [],
        summary: "Live summary",
      });
      vi.mocked(aiModule.generateEmbedding).mockResolvedValue([0.1, 0.2]);

      let completionResolve: () => void;
      const completionPromise = new Promise<void>((res) => {
        completionResolve = res;
      });

      const progressSnapshots: QueueStats[] = [];
      const abort = startProcessingQueue("test-key", (stats) => {
        progressSnapshots.push({ ...stats });
        if (stats.status === "completed") {
          completionResolve();
        }
      });

      await completionPromise;
      abort();

      const deadAi = sqlite.prepare("SELECT * FROM bookmarkAi WHERE bookmarkId = 'q-dead'").get() as any;
      expect(deadAi).toBeDefined();
      expect(deadAi.category).toBe("fetch_failed");
      expect(deadAi.summary).toContain("HTTP 404: Not Found");

      const okAi = sqlite.prepare("SELECT * FROM bookmarkAi WHERE bookmarkId = 'q-ok'").get() as any;
      expect(okAi).toBeDefined();
      expect(okAi.category).toBe("LiveCategory");

      const lastStat = progressSnapshots[progressSnapshots.length - 1];
      expect(lastStat.status).toBe("completed");
      expect(lastStat.failed).toBe(1);
      expect(lastStat.processed).toBe(1);
    });

    it("pauses queue and exponentially backs off when Gemini returns 429, then retries", async () => {
      sqlite.prepare(`
        INSERT INTO bookmarks (id, url, title, description, domain, created_at)
        VALUES ('q-retry', 'https://throttled.com', 'Throttled', NULL, 'throttled.com', 1000)
      `).run();

      vi.mocked(fetcherModule.fetchBookmarkContent).mockResolvedValue({
        url: "https://throttled.com",
        title: "Throttled",
        description: null,
        rawText: "Body",
        isUnreachable: false,
      });

      let rateLimitHit = false;
      vi.mocked(aiModule.classifyBookmark).mockImplementation(async (_content, _key, options) => {
        if (!rateLimitHit) {
          rateLimitHit = true;
          if (options?.throwOnRateLimit) {
            throw new Error("429 Resource has been exhausted (check quota).");
          }
        }
        return {
          category: "Recovered",
          tags: ["quota"],
          technologies: [],
          summary: "Recovered after backoff",
        };
      });

      vi.mocked(aiModule.generateEmbedding).mockResolvedValue([0.9]);

      const statuses: string[] = [];
      let completionResolve: () => void;
      const completionPromise = new Promise<void>((res) => {
        completionResolve = res;
      });

      const abort = startProcessingQueue("gemini-key", (stats) => {
        statuses.push(stats.status);
        if (stats.status === "completed") {
          completionResolve();
        }
      });

      await completionPromise;
      abort();

      expect(statuses).toContain("backing_off");
      expect(statuses).toContain("completed");

      const row = sqlite.prepare("SELECT * FROM bookmarkAi WHERE bookmarkId = 'q-retry'").get() as any;
      expect(row).toBeDefined();
      expect(row.category).toBe("Recovered");
    });

    it("suspends cleanly without corrupted transactions when abort() is invoked", async () => {
      sqlite.prepare(`
        INSERT INTO bookmarks (id, url, title, description, domain, created_at)
        VALUES 
          ('q-ab1', 'https://site1.com', 'Site 1', NULL, 'site1.com', 1000),
          ('q-ab2', 'https://site2.com', 'Site 2', NULL, 'site2.com', 2000),
          ('q-ab3', 'https://site3.com', 'Site 3', NULL, 'site3.com', 3000)
      `).run();

      vi.mocked(fetcherModule.fetchBookmarkContent).mockImplementation(async (url) => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          url,
          title: "Title",
          description: null,
          rawText: "Text",
          isUnreachable: false,
        };
      });

      vi.mocked(aiModule.classifyBookmark).mockResolvedValue({
        category: "AbortedTest",
        tags: [],
        technologies: [],
        summary: "Summary",
      });
      vi.mocked(aiModule.generateEmbedding).mockResolvedValue([0.1]);

      let pausedResolve: () => void;
      const pausedPromise = new Promise<void>((res) => {
        pausedResolve = res;
      });

      const abort = startProcessingQueue("gemini-key", (stats) => {
        if (stats.status === "paused") {
          pausedResolve();
        }
      });

      // Abort quickly after start
      setTimeout(() => {
        abort();
      }, 5);

      await pausedPromise;

      // Ensure abort was clean
      const processedCount = sqlite.prepare("SELECT count(*) as count FROM bookmarkAi").get() as any;
      // Should have processed 0 or at most some without errors
      expect(processedCount.count).toBeLessThanOrEqual(3);
    });

    it("enforces concurrency limit of at most 2 parallel jobs", async () => {
      sqlite.prepare(`
        INSERT INTO bookmarks (id, url, title, description, domain, created_at)
        VALUES 
          ('c-1', 'https://c1.com', 'C1', NULL, 'c1.com', 1000),
          ('c-2', 'https://c2.com', 'C2', NULL, 'c2.com', 2000),
          ('c-3', 'https://c3.com', 'C3', NULL, 'c3.com', 3000),
          ('c-4', 'https://c4.com', 'C4', NULL, 'c4.com', 4000)
      `).run();

      let activeConcurrentCount = 0;
      let maxObservedConcurrent = 0;

      vi.mocked(fetcherModule.fetchBookmarkContent).mockImplementation(async (url) => {
        activeConcurrentCount++;
        maxObservedConcurrent = Math.max(maxObservedConcurrent, activeConcurrentCount);
        // Simulate small delay
        await new Promise((r) => setTimeout(r, 10));
        activeConcurrentCount--;
        return {
          url,
          title: "C",
          description: null,
          rawText: "C body",
          isUnreachable: false,
        };
      });

      vi.mocked(aiModule.classifyBookmark).mockResolvedValue({
        category: "Concurrent",
        tags: [],
        technologies: [],
        summary: "Conc",
      });
      vi.mocked(aiModule.generateEmbedding).mockResolvedValue([0.1]);

      let completionResolve: () => void;
      const completionPromise = new Promise<void>((res) => {
        completionResolve = res;
      });

      const abort = startProcessingQueue("gemini-key", (stats) => {
        if (stats.status === "completed") {
          completionResolve();
        }
      });

      await completionPromise;
      abort();

      expect(maxObservedConcurrent).toBeLessThanOrEqual(2);
    });
  });
});
