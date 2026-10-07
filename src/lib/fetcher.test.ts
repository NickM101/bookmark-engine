// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTauriFetch = vi.fn();

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: any[]) => mockTauriFetch(...args),
}));

import { parseBookmarkHtml, fetchBookmarkContent } from "./fetcher";

describe("parseBookmarkHtml DOM parsing utility", () => {
  it("extracts title, meta description, and clean body text stripping unwanted tags", () => {
    const rawHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>React – A JavaScript library for building user interfaces</title>
  <meta name="description" content="A JavaScript library for building user interfaces." />
  <style>
    body { font-family: sans-serif; }
    .nav { display: flex; }
  </style>
  <script>
    console.log("Analytics tracker code that should be stripped");
  </script>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/docs">Docs</a>
  </nav>

  <header>
    <h1>Site Header Banner</h1>
  </header>

  <main>
    <h2>Welcome to React</h2>
    <p>React makes it painless to create interactive UIs. Design simple views for each state in your application.</p>
    <svg width="100" height="100">
      <circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" />
    </svg>
    <p>Component-Based: Build encapsulated components that manage their own state, then compose them to make complex UIs.</p>
  </main>

  <footer>
    <p>Copyright 2026 Meta Platforms, Inc.</p>
  </footer>

  <script src="/bundle.js"></script>
</body>
</html>
    `;

    const result = parseBookmarkHtml(rawHtml);

    expect(result.title).toBe(
      "React – A JavaScript library for building user interfaces"
    );
    expect(result.description).toBe(
      "A JavaScript library for building user interfaces."
    );

    // Verify stripped tags
    expect(result.rawText).not.toContain("Analytics tracker");
    expect(result.rawText).not.toContain("font-family: sans-serif");
    expect(result.rawText).not.toContain("<circle");
    expect(result.rawText).not.toContain("Home Docs");

    // Verify main readable text is present
    expect(result.rawText).toContain("Welcome to React");
    expect(result.rawText).toContain("React makes it painless to create interactive UIs.");
    expect(result.rawText).toContain("Component-Based: Build encapsulated components");
  });

  it("falls back to OpenGraph meta tags if title or description tags are missing", () => {
    const rawHtml = `
<html>
<head>
  <meta property="og:title" content="OpenGraph Fallback Title" />
  <meta property="og:description" content="OpenGraph Fallback Description" />
</head>
<body>
  <p>Article body content goes here.</p>
</body>
</html>
    `;

    const result = parseBookmarkHtml(rawHtml);
    expect(result.title).toBe("OpenGraph Fallback Title");
    expect(result.description).toBe("OpenGraph Fallback Description");
    expect(result.rawText).toBe("Article body content goes here.");
  });
});

describe("fetchBookmarkContent", () => {
  beforeEach(() => {
    mockTauriFetch.mockReset();
  });

  it("fetches and parses bookmark content using Tauri HTTP plugin on 200 OK", async () => {
    const sampleHtml = `
<html>
<head>
  <title>Vite Next Generation Frontend Tooling</title>
  <meta name="description" content="Get ready for a development environment that can finally keep up with you." />
</head>
<body>
  <main>
    <p>Vite is a build tool that aims to provide a faster and leaner development experience.</p>
  </main>
</body>
</html>
    `;

    mockTauriFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => sampleHtml,
    });

    const result = await fetchBookmarkContent("https://vite.dev");

    expect(mockTauriFetch).toHaveBeenCalledWith(
      "https://vite.dev",
      expect.objectContaining({
        method: "GET",
      })
    );

    expect(result.url).toBe("https://vite.dev");
    expect(result.title).toBe("Vite Next Generation Frontend Tooling");
    expect(result.description).toBe(
      "Get ready for a development environment that can finally keep up with you."
    );
    expect(result.rawText).toContain("Vite is a build tool that aims to provide");
    expect(result.error).toBeNull();
    expect(result.isUnreachable).toBe(false);
    expect(result.statusCode).toBe(200);
  });

  it("fails gracefully on HTTP 404 and returns structured unreachable error", async () => {
    mockTauriFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "Page not found",
    });

    const result = await fetchBookmarkContent("https://example.com/dead-link");

    expect(result.url).toBe("https://example.com/dead-link");
    expect(result.title).toBeNull();
    expect(result.description).toBeNull();
    expect(result.rawText).toBe("");
    expect(result.statusCode).toBe(404);
    expect(result.isUnreachable).toBe(true);
    expect(result.error).toContain("404");
  });

  it("fails gracefully on HTTP 403 Forbidden", async () => {
    mockTauriFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "Access denied",
    });

    const result = await fetchBookmarkContent("https://private.com/secret");

    expect(result.url).toBe("https://private.com/secret");
    expect(result.statusCode).toBe(403);
    expect(result.isUnreachable).toBe(true);
    expect(result.error).toContain("403");
  });

  it("fails gracefully on timeout / network error", async () => {
    mockTauriFetch.mockRejectedValueOnce(
      new Error("Network connection timed out")
    );

    const result = await fetchBookmarkContent("https://timeout-site.org");

    expect(result.url).toBe("https://timeout-site.org");
    expect(result.title).toBeNull();
    expect(result.description).toBeNull();
    expect(result.rawText).toBe("");
    expect(result.isUnreachable).toBe(true);
    expect(result.error).toContain("timed out");
  });
});
