// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchBookmarks,
  getRecentBookmarks,
  getFolderContents,
  getFolderTree,
  getFolderBookmarks,
  formatSearchQuery,
  cosineSimilarity,
  semanticSearch,
  findDuplicateBookmarks,
  type Bookmark,
  type Folder,
} from "./api";
import * as dbModule from "./db";
import * as aiModule from "./ai";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

describe("formatSearchQuery", () => {
  it("appends wildcard to alphanumeric queries", () => {
    expect(formatSearchQuery("react")).toBe("react*");
    expect(formatSearchQuery("vite dev")).toBe("vite dev*");
  });

  it("does not append extra wildcard if one already exists", () => {
    expect(formatSearchQuery("react*")).toBe("react*");
  });

  it("handles punctuation by quoting", () => {
    expect(formatSearchQuery("next.js")).toBe('"next.js"*');
  });

  it("returns empty string for blank queries", () => {
    expect(formatSearchQuery("")).toBe("");
    expect(formatSearchQuery("   ")).toBe("");
  });
});

describe("Core Engine API queries", () => {
  it("searchBookmarks executes FTS query with MATCH operator and rank ordering", async () => {
    const executedQueries: { query: string; params?: unknown[] }[] = [];

    const mockBookmarks: Bookmark[] = [
      {
        id: "b-1",
        url: "https://react.dev",
        title: "React Official",
        description: "The React Library",
        domain: "react.dev",
        created_at: 1600000000000,
      },
    ];

    const mockDb = {
      select: async (query: string, params?: unknown[]) => {
        executedQueries.push({ query, params });
        return mockBookmarks;
      },
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    const results = await searchBookmarks("react");

    expect(results).toEqual(mockBookmarks);
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].query).toContain("bookmarks_fts MATCH ?");
    expect(executedQueries[0].query).toContain("ORDER BY rank");
    expect(executedQueries[0].params).toEqual(["react*"]);

    // Test blank query returns [] without db call
    const blankResults = await searchBookmarks("  ");
    expect(blankResults).toEqual([]);
    expect(executedQueries).toHaveLength(1);

    getDbSpy.mockRestore();
  });

  it("getRecentBookmarks sorts created_at DESC with limit", async () => {
    const executedQueries: { query: string; params?: unknown[] }[] = [];

    const mockBookmarks: Bookmark[] = [
      {
        id: "b-2",
        url: "https://vite.dev",
        title: "Vite",
        description: null,
        domain: "vite.dev",
        created_at: 1700000000000,
      },
    ];

    const mockDb = {
      select: async (query: string, params?: unknown[]) => {
        executedQueries.push({ query, params });
        return mockBookmarks;
      },
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    // Default limit = 50
    const resDefault = await getRecentBookmarks();
    expect(resDefault).toEqual(mockBookmarks);
    expect(executedQueries[0].query).toContain("ORDER BY created_at DESC");
    expect(executedQueries[0].query).toContain("LIMIT ?");
    expect(executedQueries[0].params).toEqual([50]);

    // Custom limit = 10
    await getRecentBookmarks(10);
    expect(executedQueries[1].params).toEqual([10]);

    getDbSpy.mockRestore();
  });

  it("getFolderContents returns subfolders and bookmarks joining bookmark_folders", async () => {
    const executedQueries: { query: string; params?: unknown[] }[] = [];

    const mockSubfolders: Folder[] = [
      { id: "f-sub", name: "React Components", parent_id: "f-root" },
    ];
    const mockBookmarks: Bookmark[] = [
      {
        id: "b-3",
        url: "https://react.dev/hooks",
        title: "React Hooks",
        description: null,
        domain: "react.dev",
        created_at: 1650000000000,
      },
    ];

    const mockDb = {
      select: async (query: string, params?: unknown[]) => {
        executedQueries.push({ query, params });
        if (query.includes("FROM folders")) {
          return mockSubfolders;
        }
        if (query.includes("FROM bookmarks")) {
          return mockBookmarks;
        }
        return [];
      },
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    const contents = await getFolderContents("f-root");

    expect(contents.subfolders).toEqual(mockSubfolders);
    expect(contents.folders).toEqual(mockSubfolders);
    expect(contents.bookmarks).toEqual(mockBookmarks);

    // Verify subfolder query
    expect(executedQueries[0].query).toContain("FROM folders");
    expect(executedQueries[0].query).toContain("WHERE parent_id = ?");
    expect(executedQueries[0].params).toEqual(["f-root"]);

    // Verify bookmark query joining bookmark_folders
    expect(executedQueries[1].query).toContain("JOIN bookmark_folders");
    expect(executedQueries[1].query).toContain("WHERE bf.folder_id = ?");
    expect(executedQueries[1].params).toEqual(["f-root"]);

    getDbSpy.mockRestore();
  });

  it("getFolderTree builds tree structure with bookmark counts", async () => {
    const mockFolders: Folder[] = [
      { id: "f-root", name: "Root Folder", parent_id: null },
      { id: "f-child", name: "Child Folder", parent_id: "f-root" },
    ];
    const mockCounts = [
      { folder_id: "f-root", count: 5 },
      { folder_id: "f-child", count: 12 },
    ];

    const mockDb = {
      select: async (query: string) => {
        if (query.includes("FROM folders")) {
          return mockFolders;
        }
        if (query.includes("FROM bookmark_folders")) {
          return mockCounts;
        }
        return [];
      },
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    const tree = await getFolderTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("f-root");
    expect(tree[0].bookmarkCount).toBe(17);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe("f-child");
    expect(tree[0].children[0].bookmarkCount).toBe(12);

    getDbSpy.mockRestore();
  });

  it("getFolderBookmarks fetches bookmarks with recursive query", async () => {
    const executedQueries: { query: string; params?: unknown[] }[] = [];
    const mockBookmarks: Bookmark[] = [
      {
        id: "b-1",
        url: "https://react.dev",
        title: "React",
        description: null,
        domain: "react.dev",
        created_at: 1000,
      },
    ];

    const mockDb = {
      select: async (query: string, params?: unknown[]) => {
        executedQueries.push({ query, params });
        return mockBookmarks;
      },
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    const results = await getFolderBookmarks("f-test", true);
    expect(results).toEqual(mockBookmarks);
    expect(executedQueries[0].query).toContain("WITH RECURSIVE folder_hierarchy");
    expect(executedQueries[0].params).toEqual(["f-test"]);

    getDbSpy.mockRestore();
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [0.2, 0.4, 0.6, 0.8];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const v1 = [1, 0, 0];
    const v2 = [0, 1, 0];
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const v1 = [0.5, 0.5];
    const v2 = [-0.5, -0.5];
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(-1, 5);
  });

  it("gracefully handles zero-magnitude vectors without division by zero or NaN", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("handles empty vectors gracefully", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [])).toBe(0);
    expect(cosineSimilarity([], [3, 4])).toBe(0);
  });
});

describe("semanticSearch", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
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
        processedAt INTEGER
      );
      CREATE TABLE bookmarkEmbeddings (
        bookmarkId TEXT PRIMARY KEY,
        embedding TEXT
      );
    `);
    const db = drizzle(sqlite);
    dbModule.setDrizzleDb(db);
    vi.spyOn(aiModule, "embedSearchQuery").mockResolvedValue([1.0, 0.0]);
  });

  afterEach(() => {
    dbModule.resetDrizzleDb();
    sqlite.close();
    vi.restoreAllMocks();
  });

  it("executes semantic search, computes similarity, sorts descending, and joins AI metadata", async () => {
    // Seed bookmarks
    sqlite.prepare("INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?, ?)").run(
      "b-react",
      "https://react.dev",
      "React",
      "UI library",
      "react.dev",
      1000
    );
    sqlite.prepare("INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?, ?)").run(
      "b-vue",
      "https://vue.dev",
      "Vue",
      "Progressive framework",
      "vue.dev",
      2000
    );
    sqlite.prepare("INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?, ?)").run(
      "b-rust",
      "https://rust-lang.org",
      "Rust",
      "Systems language",
      "rust-lang.org",
      3000
    );

    // Seed AI metadata for b-react
    sqlite.prepare("INSERT INTO bookmarkAi VALUES (?, ?, ?, ?, ?, ?)").run(
      "b-react",
      "React overview summary",
      "Frontend",
      JSON.stringify(["ui", "web"]),
      JSON.stringify(["React", "JSX"]),
      12345
    );

    // Seed Embeddings:
    // Query will be [1.0, 0.0]
    // b-react is [0.99, 0.01] (very close)
    // b-vue is [0.707, 0.707] (moderately close)
    // b-rust is [0.0, 1.0] (orthogonal)
    sqlite.prepare("INSERT INTO bookmarkEmbeddings VALUES (?, ?)").run("b-react", JSON.stringify([0.99, 0.01]));
    sqlite.prepare("INSERT INTO bookmarkEmbeddings VALUES (?, ?)").run("b-vue", JSON.stringify([0.707, 0.707]));
    sqlite.prepare("INSERT INTO bookmarkEmbeddings VALUES (?, ?)").run("b-rust", JSON.stringify([0.0, 1.0]));

    vi.spyOn(aiModule, "embedSearchQuery").mockResolvedValue([1.0, 0.0]);

    const results = await semanticSearch("frontend user interface components", "test-key");

    expect(results).toHaveLength(3);
    // Highest score should be b-react first
    expect(results[0].id).toBe("b-react");
    expect(results[0].similarityScore).toBeGreaterThan(0.9);
    expect(results[0].ai).toBeDefined();
    expect(results[0].ai?.category).toBe("Frontend");
    expect(results[0].ai?.tags).toEqual(["ui", "web"]);
    expect(results[0].ai?.technologies).toEqual(["React", "JSX"]);

    // Second should be b-vue
    expect(results[1].id).toBe("b-vue");
    expect(results[1].similarityScore).toBeGreaterThan(0.5);
    expect(results[1].ai).toBeNull(); // No AI metadata was inserted for b-vue

    // Last should be b-rust
    expect(results[2].id).toBe("b-rust");
    expect(results[2].similarityScore).toBeCloseTo(0, 2);
  });

  it("limits results to the top 15 highest-scoring bookmarks when more exist", async () => {
    // Seed 20 bookmarks with embeddings
    const insertBookmark = sqlite.prepare("INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?, ?)");
    const insertEmbedding = sqlite.prepare("INSERT INTO bookmarkEmbeddings VALUES (?, ?)");

    for (let i = 1; i <= 20; i++) {
      const id = `b-${i}`;
      insertBookmark.run(id, `https://site-${i}.com`, `Site ${i}`, null, `site-${i}.com`, i * 100);
      // Give each a slightly different vector along the axis
      insertEmbedding.run(id, JSON.stringify([i / 20, 1 - i / 20]));
    }

    vi.spyOn(aiModule, "embedSearchQuery").mockResolvedValue([1.0, 0.0]);

    const results = await semanticSearch("query", "test-key");

    expect(results).toHaveLength(15);
    // Verified scores are in descending order
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].similarityScore).toBeGreaterThanOrEqual(results[i + 1].similarityScore);
    }
  });

  it("returns empty array for blank query or when no embeddings exist", async () => {
    const emptyQueryResult = await semanticSearch("   ", "test-key");
    expect(emptyQueryResult).toEqual([]);

    const noEmbeddingsResult = await semanticSearch("anything", "test-key");
    expect(noEmbeddingsResult).toEqual([]);
  });
});

describe("findDuplicateBookmarks - URL normalization & content hash deduplication", () => {
  let sqlite: Database.Database;
  let testDrizzleDb: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
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
        processedAt INTEGER
      );
    `);

    testDrizzleDb = drizzle(sqlite);
    dbModule.setDrizzleDb(testDrizzleDb);
  });

  afterEach(() => {
    dbModule.resetDrizzleDb();
    sqlite.close();
  });

  it("detects bookmarks sharing the same normalized URL (ignoring trailing slashes & tracking params)", async () => {
    // b1 has trailing slash and utm params; b2 has clean URL
    sqlite.prepare(`
      INSERT INTO bookmarks (id, url, title, description, domain, created_at)
      VALUES 
        ('b-dup1', 'https://react.dev/learn/?utm_source=twitter&ref=dev', 'Learn React', 'Docs', 'react.dev', 1000),
        ('b-dup2', 'https://react.dev/learn', 'Quickstart React', 'Docs', 'react.dev', 2000),
        ('b-unique', 'https://vite.dev', 'Vite', 'Build tool', 'vite.dev', 3000)
    `).run();

    const groups = await findDuplicateBookmarks();

    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe("normalized_url");
    expect(groups[0].normalizedUrl).toBe("https://react.dev/learn");
    expect(groups[0].count).toBe(2);
    expect(groups[0].bookmarks.map((b) => b.id).sort()).toEqual(["b-dup1", "b-dup2"]);
  });

  it("detects bookmarks sharing the same content hash even if URLs differ", async () => {
    sqlite.prepare(`
      INSERT INTO bookmarks (id, url, title, description, domain, created_at)
      VALUES 
        ('b-c1', 'https://cdn.example.com/mirror/react-guide', 'React Guide', 'A guide', 'example.com', 1000),
        ('b-c2', 'https://example.com/articles/react-guide', 'React Guide', 'A guide', 'example.com', 2000),
        ('b-c3', 'https://other.com/vue-guide', 'Vue Guide', 'A guide', 'other.com', 3000)
    `).run();

    const groups = await findDuplicateBookmarks();

    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe("content_hash");
    expect(groups[0].count).toBe(2);
    expect(groups[0].bookmarks.map((b) => b.id).sort()).toEqual(["b-c1", "b-c2"]);
  });

  it("returns an empty array when no duplicate bookmarks exist", async () => {
    sqlite.prepare(`
      INSERT INTO bookmarks (id, url, title, description, domain, created_at)
      VALUES 
        ('b-1', 'https://apple.com', 'Apple', NULL, 'apple.com', 1000),
        ('b-2', 'https://google.com', 'Google', NULL, 'google.com', 2000)
    `).run();

    const groups = await findDuplicateBookmarks();
    expect(groups).toEqual([]);
  });
});


