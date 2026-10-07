import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const bookmarks = sqliteTable("bookmarks", {
  id: text("id").primaryKey(),
  url: text("url").unique(),
  title: text("title"),
  description: text("description"),
  domain: text("domain"),
  createdAt: integer("created_at"),
});

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  name: text("name"),
  parentId: text("parent_id"),
});

export const bookmarkFolders = sqliteTable(
  "bookmark_folders",
  {
    bookmarkId: text("bookmark_id").notNull(),
    folderId: text("folder_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bookmarkId, table.folderId] }),
  ]
);

export const bookmarkAi = sqliteTable("bookmarkAi", {
  bookmarkId: text("bookmarkId")
    .primaryKey()
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  summary: text("summary"),
  category: text("category"),
  tags: text("tags"),
  technologies: text("technologies"),
  processedAt: integer("processedAt"),
});

export const bookmarkEmbeddings = sqliteTable("bookmarkEmbeddings", {
  bookmarkId: text("bookmarkId")
    .primaryKey()
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  embedding: text("embedding"),
});

export type BookmarkRecord = typeof bookmarks.$inferSelect;
export type BookmarkAiRecord = typeof bookmarkAi.$inferSelect;
export type InsertBookmarkAi = typeof bookmarkAi.$inferInsert;
export type BookmarkEmbeddingRecord = typeof bookmarkEmbeddings.$inferSelect;
export type InsertBookmarkEmbedding = typeof bookmarkEmbeddings.$inferInsert;
