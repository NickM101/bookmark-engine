import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyBookmark,
  generateEmbedding,
  embedSearchQuery,
  clearGenAIClientCache,
  type BookmarkMetadata,
} from "./ai";
import { GoogleGenAI } from "@google/genai";

const mockGenerateContent = vi.fn();
const mockEmbedContent = vi.fn();

vi.mock("@google/genai", () => {
  const MockGoogleGenAI = vi.fn().mockImplementation(function (
    this: any,
    config: { apiKey: string }
  ) {
    return {
      apiKey: config.apiKey,
      models: {
        generateContent: mockGenerateContent,
        embedContent: mockEmbedContent,
      },
    };
  });

  return {
    GoogleGenAI: MockGoogleGenAI,
  };
});

describe("ai.ts - Gemini AI layer", () => {
  const dummyApiKey = "AIzaSyMockKeyForTesting123";

  beforeEach(() => {
    vi.clearAllMocks();
    clearGenAIClientCache();
  });

  describe("classifyBookmark", () => {
    const sampleContent = {
      title: "React 19 Documentation",
      description: "Learn how to build user interfaces with React 19.",
      rawText: "React lets you build user interfaces out of individual pieces called components.",
    };

    it("initializes GoogleGenAI with the provided API key and calls gemini-3.8-flash", async () => {
      const mockResult: BookmarkMetadata = {
        category: "Frontend",
        tags: ["react", "ui", "javascript"],
        technologies: ["React", "TypeScript"],
        summary: "Official documentation and guide for React 19 frontend development.",
      };

      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(mockResult),
      });

      const result = await classifyBookmark(sampleContent, dummyApiKey);

      expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: dummyApiKey });
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-3.8-flash",
          contents: expect.stringContaining("React 19 Documentation"),
          config: expect.objectContaining({
            responseMimeType: "application/json",
            systemInstruction: expect.stringContaining("bookmark organizer for a software developer"),
          }),
        })
      );

      expect(result).toEqual(mockResult);
    });

    it("properly parses and sanitizes the JSON response", async () => {
      const rawJsonResponse = {
        category: "DevOps",
        tags: ["docker", "containers"],
        technologies: ["Docker", "Kubernetes"],
        summary: "Introduction to containerization with Docker.",
      };

      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify(rawJsonResponse),
      });

      const result = await classifyBookmark(
        {
          title: "Docker Guide",
          description: "Get started with Docker containers",
          rawText: "Docker packages software into standardized units.",
        },
        dummyApiKey
      );

      expect(result.category).toBe("DevOps");
      expect(result.tags).toEqual(["docker", "containers"]);
      expect(result.technologies).toEqual(["Docker", "Kubernetes"]);
      expect(result.summary).toBe("Introduction to containerization with Docker.");
    });

    it("handles rate limiting (HTTP 429) gracefully without throwing or crashing", async () => {
      mockGenerateContent.mockRejectedValueOnce(
        new Error("429 Resource has been exhausted (e.g. check quota).")
      );

      const result = await classifyBookmark(sampleContent, dummyApiKey);

      expect(result).toEqual({
        category: "Uncategorized",
        tags: [],
        technologies: [],
        summary: "",
      });
    });

    it("handles invalid or malformed JSON from the model response gracefully", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: "Invalid non-JSON response from model",
      });

      const result = await classifyBookmark(sampleContent, dummyApiKey);

      expect(result).toEqual({
        category: "Uncategorized",
        tags: [],
        technologies: [],
        summary: "",
      });
    });

    it("handles empty or missing API key gracefully without crashing", async () => {
      const result = await classifyBookmark(sampleContent, "");

      expect(GoogleGenAI).not.toHaveBeenCalled();
      expect(result).toEqual({
        category: "Uncategorized",
        tags: [],
        technologies: [],
        summary: "",
      });
    });
  });

  describe("generateEmbedding", () => {
    it("generates a semantic embedding vector using text-embedding-004", async () => {
      const expectedVector = [0.1234, -0.5678, 0.9101, -0.1122];

      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: expectedVector }],
      });

      const result = await generateEmbedding("Rust async concurrency programming", dummyApiKey);

      expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: dummyApiKey });
      expect(mockEmbedContent).toHaveBeenCalledWith({
        model: "text-embedding-004",
        contents: "Rust async concurrency programming",
      });
      expect(result).toEqual(expectedVector);
    });

    it("supports single embedding object response format (response.embedding.values)", async () => {
      const expectedVector = [0.55, -0.44, 0.33];

      mockEmbedContent.mockResolvedValueOnce({
        embedding: { values: expectedVector },
      });

      const result = await generateEmbedding("Machine learning deep neural networks", dummyApiKey);

      expect(result).toEqual(expectedVector);
    });

    it("handles API errors / rate limits gracefully and returns an empty array", async () => {
      mockEmbedContent.mockRejectedValueOnce(new Error("503 Service Unavailable"));

      const result = await generateEmbedding("Some text to embed", dummyApiKey);

      expect(result).toEqual([]);
    });

    it("returns an empty array when given empty text or missing API key without calling the API", async () => {
      const emptyTextResult = await generateEmbedding("   ", dummyApiKey);
      expect(emptyTextResult).toEqual([]);
      expect(mockEmbedContent).not.toHaveBeenCalled();

      const missingKeyResult = await generateEmbedding("Hello world", "");
      expect(missingKeyResult).toEqual([]);
    });

    it("embedSearchQuery embeds the query string using text-embedding-004", async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [0.11, 0.22, 0.33] }],
      });

      const result = await embedSearchQuery("react state management", dummyApiKey);

      expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: dummyApiKey });
      expect(mockEmbedContent).toHaveBeenCalledWith({
        model: "text-embedding-004",
        contents: "react state management",
      });
      expect(result).toEqual([0.11, 0.22, 0.33]);
    });
  });
});
