CREATE TABLE `bookmarkAi` (
	`bookmarkId` text PRIMARY KEY NOT NULL,
	`summary` text,
	`category` text,
	`tags` text,
	`technologies` text,
	`processedAt` integer,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bookmarkEmbeddings` (
	`bookmarkId` text PRIMARY KEY NOT NULL,
	`embedding` text,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bookmark_folders` (
	`bookmark_id` text NOT NULL,
	`folder_id` text NOT NULL,
	PRIMARY KEY(`bookmark_id`, `folder_id`)
);
--> statement-breakpoint
CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text,
	`title` text,
	`description` text,
	`domain` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmarks_url_unique` ON `bookmarks` (`url`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`parent_id` text
);
