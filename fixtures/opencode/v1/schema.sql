-- Synthetic OpenCode 1.x storage: `session`, `message`, and `part` in the
-- final 1.x shape (anomalyco/opencode v1.18.35 packages/core/src/session/sql.ts),
-- minus foreign keys so malformed fixtures can hold orphan parts. A 2.x
-- database created by a 2.x release carries these tables too, usually empty
-- (2.x replays the 1.x migrations, and its migrator never drops them), so
-- buildOpenCodeDb applies this after schema.sql. A pre-release 2.x database
-- from before the table split differs (see ../next/pre-split.sql).
CREATE TABLE `session` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `parent_id` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `path` text,
  `title` text NOT NULL,
  `version` text NOT NULL,
  `share_url` text,
  `summary_additions` integer,
  `summary_deletions` integer,
  `summary_files` integer,
  `summary_diffs` text,
  `metadata` text,
  `cost` real DEFAULT 0 NOT NULL,
  `tokens_input` integer DEFAULT 0 NOT NULL,
  `tokens_output` integer DEFAULT 0 NOT NULL,
  `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL,
  `tokens_cache_write` integer DEFAULT 0 NOT NULL,
  `revert` text,
  `permission` text,
  `agent` text,
  `model` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_compacting` integer,
  `time_archived` integer
);
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
CREATE TABLE `message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`, `time_created`, `id`);
CREATE TABLE `part` (
  `id` text PRIMARY KEY,
  `message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`, `id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
