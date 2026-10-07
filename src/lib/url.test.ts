import { describe, it, expect } from "vitest";
import { normalizeUrl, isDocumentationDeepLink, computeContentHash } from "./url";

describe("url.ts - normalizeUrl", () => {
  describe("Tracking parameters stripping", () => {
    it("strips standard utm_* parameters", () => {
      const input = "https://example.com/article?utm_source=twitter&utm_medium=social&utm_campaign=spring2026&utm_content=cta&utm_term=react";
      expect(normalizeUrl(input)).toBe("https://example.com/article");
    });

    it("strips ad and social click identifiers (fbclid, gclid, msclkid, twclid, si)", () => {
      const input = "https://youtube.com/watch?v=dQw4w9WgXcQ&si=share123&fbclid=fb456&gclid=g789";
      expect(normalizeUrl(input)).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    });

    it("strips referral parameters (ref, ref_src, referrer)", () => {
      const input = "https://producthunt.com/posts/awesome-app?ref=newsletter&ref_src=email";
      expect(normalizeUrl(input)).toBe("https://producthunt.com/posts/awesome-app");
    });

    it("preserves meaningful non-tracking query parameters and sorts them", () => {
      const input = "https://example.com/search?z_param=last&utm_source=ad&a_param=first&id=123";
      expect(normalizeUrl(input)).toBe("https://example.com/search?a_param=first&id=123&z_param=last");
    });

    it("handles URLs with trailing slashes before query parameters", () => {
      const input = "https://example.com/foo/?id=99&utm_medium=email";
      expect(normalizeUrl(input)).toBe("https://example.com/foo?id=99");
    });
  });

  describe("Trailing slashes normalization", () => {
    it("normalizes example.com/foo/ to example.com/foo", () => {
      expect(normalizeUrl("example.com/foo/")).toBe("example.com/foo");
    });

    it("normalizes https://example.com/foo/ to https://example.com/foo", () => {
      expect(normalizeUrl("https://example.com/foo/")).toBe("https://example.com/foo");
    });

    it("normalizes nested paths https://example.com/foo/bar/ to https://example.com/foo/bar", () => {
      expect(normalizeUrl("https://example.com/foo/bar/")).toBe("https://example.com/foo/bar");
    });

    it("normalizes root trailing slash https://example.com/ to https://example.com", () => {
      expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    });

    it("collapses multiple consecutive slashes in pathname", () => {
      expect(normalizeUrl("https://example.com//foo///bar//")).toBe("https://example.com/foo/bar");
    });
  });

  describe("Protocol and hostname normalization", () => {
    it("lowercases protocol and hostname while preserving path casing", () => {
      expect(normalizeUrl("HTTP://Example.COM/FooBar")).toBe("http://example.com/FooBar");
      expect(normalizeUrl("HTTPS://GITHUB.COM/facebook/react/")).toBe("https://github.com/facebook/react");
    });

    it("strips default port 80 for HTTP", () => {
      expect(normalizeUrl("http://example.com:80/docs")).toBe("http://example.com/docs");
    });

    it("strips default port 443 for HTTPS", () => {
      expect(normalizeUrl("https://example.com:443/docs")).toBe("https://example.com/docs");
    });

    it("preserves non-default ports", () => {
      expect(normalizeUrl("https://localhost:8080/api/v1/")).toBe("https://localhost:8080/api/v1");
    });
  });

  describe("Hash fragments and documentation deep-links", () => {
    it("preserves markdown section hashes (#installation, #getting-started, #api-reference)", () => {
      expect(normalizeUrl("https://github.com/facebook/react#installation")).toBe(
        "https://github.com/facebook/react#installation"
      );
      expect(normalizeUrl("https://docs.docker.com/guide/#getting-started")).toBe(
        "https://docs.docker.com/guide#getting-started"
      );
      expect(normalizeUrl("https://example.com/docs/#api-reference")).toBe(
        "https://example.com/docs#api-reference"
      );
      expect(normalizeUrl("https://github.com/org/repo/blob/main/code.ts#L10-L25")).toBe(
        "https://github.com/org/repo/blob/main/code.ts#L10-L25"
      );
    });

    it("strips generic non-documentation hashes (#top, #comments, #header, #main-content)", () => {
      expect(normalizeUrl("https://example.com/blog/article#top")).toBe(
        "https://example.com/blog/article"
      );
      expect(normalizeUrl("https://example.com/blog/article/#comments")).toBe(
        "https://example.com/blog/article"
      );
      expect(normalizeUrl("https://example.com/page#main-content")).toBe(
        "https://example.com/page"
      );
      expect(normalizeUrl("https://example.com/page#header")).toBe(
        "https://example.com/page"
      );
      expect(normalizeUrl("https://example.com/page#")).toBe(
        "https://example.com/page"
      );
    });

    it("strips Chrome scroll-to-text fragments (#:~:text=...)", () => {
      expect(
        normalizeUrl("https://en.wikipedia.org/wiki/React#:~:text=React%20is%20a%20free")
      ).toBe("https://en.wikipedia.org/wiki/React");
    });

    it("strips tracking parameters placed inside hashes", () => {
      expect(
        normalizeUrl("https://example.com/page#utm_source=twitter&utm_medium=social")
      ).toBe("https://example.com/page");
    });
  });

  describe("Edge cases & robustness", () => {
    it("handles empty or whitespace strings gracefully", () => {
      expect(normalizeUrl("")).toBe("");
      expect(normalizeUrl("   ")).toBe("");
    });

    it("handles combined normalization: uppercase protocol, port, trailing slash, tracking params, and doc hash", () => {
      const input = "HTTPS://DOCS.ASTRO.BUILD:443/en/getting-started/?utm_source=newsletter&utm_medium=email#installation";
      expect(normalizeUrl(input)).toBe("https://docs.astro.build/en/getting-started#installation");
    });
  });
});

describe("url.ts - isDocumentationDeepLink", () => {
  it("returns true for section anchors", () => {
    expect(isDocumentationDeepLink("#installation")).toBe(true);
    expect(isDocumentationDeepLink("#quick-start")).toBe(true);
    expect(isDocumentationDeepLink("#api-reference")).toBe(true);
    expect(isDocumentationDeepLink("#section-1.2")).toBe(true);
    expect(isDocumentationDeepLink("#L42-L55")).toBe(true);
  });

  it("returns false for UI/jump links and tracking", () => {
    expect(isDocumentationDeepLink("")).toBe(false);
    expect(isDocumentationDeepLink("#")).toBe(false);
    expect(isDocumentationDeepLink("#top")).toBe(false);
    expect(isDocumentationDeepLink("#comments")).toBe(false);
    expect(isDocumentationDeepLink("#skip-to-content")).toBe(false);
    expect(isDocumentationDeepLink("#:~:text=foo")).toBe(false);
    expect(isDocumentationDeepLink("#utm_source=feed")).toBe(false);
  });
});

describe("url.ts - computeContentHash", () => {
  it("produces identical content hash regardless of title casing, whitespace, and punctuation", () => {
    const hash1 = computeContentHash("React Documentation", "react.dev", "UI library");
    const hash2 = computeContentHash("  react documentation!  ", "REACT.DEV", "UI library");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBeGreaterThan(0);
  });

  it("produces different hashes for different domains or titles", () => {
    const hashA = computeContentHash("React", "react.dev");
    const hashB = computeContentHash("Vue", "vuejs.org");
    expect(hashA).not.toBe(hashB);
  });
});
