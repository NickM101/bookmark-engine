// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { parseNetscapeBookmarks, importBookmarks } from "./importer";

describe("parseNetscapeBookmarks comprehensive tests", () => {
  it("parses nested folders and maintains parent-child hierarchy", () => {
    const html = `
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000001">Development</H3>
    <DL><p>
        <DT><H3 ADD_DATE="1600000002">React</H3>
        <DL><p>
            <DT><A HREF="https://react.dev" ADD_DATE="1600000003">React Official</A>
            <DD>The React Library
        </DL><p>
        <DT><A HREF="https://vite.dev" ADD_DATE="1600000004">Vite</A>
    </DL><p>
    <DT><A HREF="https://news.ycombinator.com" ADD_DATE="1600000005">Hacker News</A>
</DL><p>
    `;

    const result = parseNetscapeBookmarks(html);

    // Folders check
    expect(result.folders).toHaveLength(2);
    const devFolder = result.folders.find((f) => f.name === "Development");
    const reactFolder = result.folders.find((f) => f.name === "React");
    expect(devFolder).toBeDefined();
    expect(reactFolder).toBeDefined();
    expect(devFolder?.parentId).toBeNull();
    expect(reactFolder?.parentId).toBe(devFolder?.id);

    // Bookmarks check
    expect(result.bookmarks).toHaveLength(3);
    const reactBm = result.bookmarks.find((b) => b.url === "https://react.dev");
    const viteBm = result.bookmarks.find((b) => b.url === "https://vite.dev");
    const hnBm = result.bookmarks.find((b) => b.url === "https://news.ycombinator.com");

    expect(reactBm).toBeDefined();
    expect(reactBm?.title).toBe("React Official");
    expect(reactBm?.description).toBe("The React Library");
    expect(reactBm?.created_at).toBe(1600000003 * 1000);
    expect(reactBm?.folderId).toBe(reactFolder?.id);

    expect(viteBm).toBeDefined();
    expect(viteBm?.folderId).toBe(devFolder?.id);

    expect(hnBm).toBeDefined();
    expect(hnBm?.folderId).toBeNull();

    // Bookmark folders relationship check
    expect(result.bookmarkFolders).toContainEqual({
      bookmarkId: reactBm?.id,
      folderId: reactFolder?.id,
    });
    expect(result.bookmarkFolders).toContainEqual({
      bookmarkId: viteBm?.id,
      folderId: devFolder?.id,
    });

    // Hierarchical tree check: Development -> React -> React Official
    expect(result.tree).toHaveLength(1);
    const devTreeNode = result.tree[0];
    expect(devTreeNode.name).toBe("Development");
    expect(devTreeNode.bookmarks.map((b) => b.title)).toContain("Vite");
    expect(devTreeNode.children).toHaveLength(1);
    const reactTreeNode = devTreeNode.children[0];
    expect(reactTreeNode.name).toBe("React");
    expect(reactTreeNode.bookmarks.map((b) => b.title)).toContain("React Official");
  });

  it("handles standard Chrome export structure with Bookmarks bar", () => {
    const html = `
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1710000000" LAST_MODIFIED="1710000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><H3 ADD_DATE="1710000001">Work</H3>
        <DL><p>
            <DT><H3 ADD_DATE="1710000002">Projects</H3>
            <DL><p>
                <DT><A HREF="https://github.com/org/repo" ADD_DATE="1710000003">Repository</A>
            </DL><p>
        </DL><p>
    </DL><p>
    <DT><H3 ADD_DATE="1710000010">Other Bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://wikipedia.org" ADD_DATE="1710000011">Wikipedia</A>
    </DL><p>
</DL><p>
    `;

    const result = parseNetscapeBookmarks(html);
    expect(result.folders).toHaveLength(4);
    const bar = result.folders.find((f) => f.name === "Bookmarks bar");
    const work = result.folders.find((f) => f.name === "Work");
    const projects = result.folders.find((f) => f.name === "Projects");
    const other = result.folders.find((f) => f.name === "Other Bookmarks");

    expect(bar?.parentId).toBeNull();
    expect(work?.parentId).toBe(bar?.id);
    expect(projects?.parentId).toBe(work?.id);
    expect(other?.parentId).toBeNull();

    expect(result.bookmarks).toHaveLength(2);
    const repo = result.bookmarks.find((b) => b.url === "https://github.com/org/repo");
    const wiki = result.bookmarks.find((b) => b.url === "https://wikipedia.org");

    expect(repo?.folderId).toBe(projects?.id);
    expect(wiki?.folderId).toBe(other?.id);
  });

  it("ignores javascript bookmarklets and handles missing dates", () => {
    const html = `
<DL>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    <DT><A HREF="https://clean-url.com">Clean URL</A>
</DL>
    `;

    const result = parseNetscapeBookmarks(html);
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0].url).toBe("https://clean-url.com");
    expect(result.bookmarks[0].title).toBe("Clean URL");
    expect(result.bookmarks[0].created_at).toBeGreaterThan(0);
  });

  it("extracts domain correctly from urls", () => {
    const html = `
<DL>
    <DT><A HREF="https://sub.domain.example.com/path?foo=bar#hash">Subdomain URL</A>
</DL>
    `;

    const result = parseNetscapeBookmarks(html);
    expect(result.bookmarks[0].domain).toBe("sub.domain.example.com");
  });

  it("handles duplicate URLs in the same export by keeping separate bookmark entries for relationships", () => {
    const html = `
<DL><p>
    <DT><H3>Folder A</H3>
    <DL><p>
        <DT><A HREF="https://shared.com">Shared Link</A>
    </DL><p>
    <DT><H3>Folder B</H3>
    <DL><p>
        <DT><A HREF="https://shared.com">Shared Link</A>
    </DL><p>
</DL><p>
    `;

    const result = parseNetscapeBookmarks(html);
    expect(result.folders).toHaveLength(2);
    expect(result.bookmarks).toHaveLength(2);
    expect(result.bookmarkFolders).toHaveLength(2);
    expect(result.bookmarks[0].folderId).toBe(result.folders[0].id);
    expect(result.bookmarks[1].folderId).toBe(result.folders[1].id);
  });

  it("parses user's actual bookmarks file", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("/home/nickm/documents/bookmarks_10_7_26.html", "utf8");
    const start = Date.now();
    const result = parseNetscapeBookmarks(content);
    const duration = Date.now() - start;
    console.log(`Parsed ${result.bookmarks.length} bookmarks and ${result.folders.length} folders in ${duration}ms`);
    expect(result.bookmarks.length).toBeGreaterThan(0);
  });
});

describe("importBookmarks database ingestion", () => {
  it("batch-inserts folders, bookmarks, and relationships with transaction", async () => {
    const executedQueries: { query: string; params?: unknown[] }[] = [];

    // Mock db module
    const { importBookmarks } = await import("./importer");
    const dbModule = await import("@/lib/db");
    const mockDb = {
      execute: async (query: string, params?: unknown[]) => {
        executedQueries.push({ query, params });
        return { rowsAffected: 1 };
      },
      select: async (_query: string, _params?: unknown[]) => {
        return [];
      },
    };

    // Spy on getDatabase
    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    const sampleHtml = `
<DL><p>
    <DT><H3>Development</H3>
    <DL><p>
        <DT><A HREF="https://react.dev">React</A>
    </DL><p>
</DL><p>
    `;

    const res = await importBookmarks(sampleHtml);
    expect(res.totalParsed).toBe(1);
    expect(res.bookmarksInserted).toBe(1);
    expect(res.foldersCreated).toBe(1);
    expect(res.linksCreated).toBe(1);
    expect(res.errors).toHaveLength(0);

    // Verify queries executed
    const queryStrings = executedQueries.map((q) => q.query);
    expect(queryStrings.some((q) => q.includes("INSERT OR IGNORE INTO folders"))).toBe(true);
    expect(queryStrings.some((q) => q.includes("INSERT OR IGNORE INTO bookmarks"))).toBe(true);
    expect(queryStrings.some((q) => q.includes("INSERT OR IGNORE INTO bookmark_folders"))).toBe(true);

    getDbSpy.mockRestore();
  });

  it("handles duplicate URLs gracefully using existing ID for folder relationships", async () => {
    const executedQueries: { query: string; params?: unknown[] }[] = [];

    const { importBookmarks } = await import("./importer");
    const dbModule = await import("@/lib/db");
    const mockDb = {
      execute: async (query: string, params?: unknown[]) => {
        executedQueries.push({ query, params });
        // Simulate duplicate URL on bookmarks insert (0 rows affected)
        if (query.includes("INSERT OR IGNORE INTO bookmarks")) {
          return { rowsAffected: 0 };
        }
        return { rowsAffected: 1 };
      },
      select: async (query: string, _params?: unknown[]) => {
        if (query.includes("FROM bookmarks")) {
          return [{ id: "existing-canonical-uuid", url: "https://existing.com" }];
        }
        return [];
      },
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    const sampleHtml = `
<DL><p>
    <DT><H3>Folder 1</H3>
    <DL><p>
        <DT><A HREF="https://existing.com">Existing Site</A>
    </DL><p>
</DL><p>
    `;

    const res = await importBookmarks(sampleHtml);
    expect(res.totalParsed).toBe(1);
    expect(res.bookmarksInserted).toBe(0);
    expect(res.duplicatesIgnored).toBe(1);
    expect(res.foldersCreated).toBe(1);
    expect(res.linksCreated).toBe(1);

    // Verify folder link used canonical existing ID
    const folderLinkQuery = executedQueries.find((q) =>
      q.query.includes("INSERT OR IGNORE INTO bookmark_folders")
    );
    expect(folderLinkQuery).toBeDefined();
    expect(folderLinkQuery?.params?.[0]).toBe("existing-canonical-uuid");

    getDbSpy.mockRestore();
  });

  it("normalizes URLs and strips tracking parameters during import, deduplicating against existing canonical URLs", async () => {
    const executedQueries: { query: string; params?: unknown[] }[] = [];
    const dbModule = await import("@/lib/db");

    const mockDb = {
      select: async (query: string) => {
        if (query.includes("FROM bookmarks")) {
          return [{ id: "canon-react-id", url: "https://react.dev" }];
        }
        return [];
      },
      execute: async (query: string, params?: unknown[]) => {
        executedQueries.push({ query, params });
        return { rowsAffected: 1 };
      },
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    // HTML contains react.dev with tracking params & trailing slash (should match existing canon-react-id)
    // and a new URL with tracking params and markdown section hash (should insert normalized)
    const sampleHtml = `
<DL><p>
    <DT><A HREF="https://react.dev/?utm_source=twitter&ref=developer">React Duplicate</A>
    <DT><A HREF="https://astro.build/docs/?utm_medium=social#installation">Astro Docs</A>
</DL><p>
    `;

    const res = await importBookmarks(sampleHtml);

    expect(res.totalParsed).toBe(2);
    expect(res.duplicatesIgnored).toBe(1);
    expect(res.bookmarksInserted).toBe(1);

    // Verify inserted bookmark URL was normalized
    const insertBmQuery = executedQueries.find((q) => q.query.includes("INSERT OR IGNORE INTO bookmarks"));
    expect(insertBmQuery).toBeDefined();
    // astro.build URL should have trailing slash stripped, tracking removed, and #installation preserved
    expect(insertBmQuery?.params).toContain("https://astro.build/docs#installation");

    getDbSpy.mockRestore();
  });

  it("benchmarks importBookmarks with 1675 bookmarks", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("/home/nickm/documents/bookmarks_10_7_26.html", "utf8");

    const { importBookmarks } = await import("./importer");
    const dbModule = await import("@/lib/db");
    let queryCount = 0;

    const mockDb = {
      execute: async () => {
        queryCount++;
        return { rowsAffected: 50 };
      },
      select: async () => [],
    };

    const getDbSpy = vi.spyOn(dbModule, "getDatabase").mockResolvedValue(mockDb as any);

    const start = Date.now();
    const res = await importBookmarks(content);
    const duration = Date.now() - start;

    console.log(`Ingested ${res.totalParsed} bookmarks in ${duration}ms across ${queryCount} queries!`);
    expect(res.totalParsed).toBe(1675);
    expect(res.errors).toHaveLength(0);
    expect(duration).toBeLessThan(2000); // Must be under 2 seconds!

    getDbSpy.mockRestore();
  });
});

