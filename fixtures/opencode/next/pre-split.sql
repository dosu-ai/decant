-- Synthetic pre-release OpenCode 2.x database from before the table split
-- (anomalyco/opencode v2.0.27 packages/core/src/database/migration/
-- 20260804233008_loose_psylocke.ts): its 2.x sessions sit in a table still
-- named `session`, beside `session_message`, and there is no `session_v2`.
-- The 1.x `message` and `part` tables exist but are empty. OpenCode tells this
-- layout apart by `session_message` (v1-migration.bun.ts isNextDatabase), so
-- Decant must never read its `session` rows as 1.x sessions. Self-contained
-- (DDL included) and kept out of the top level so the CLI golden run, which
-- loads every top-level script into a 2.x database, never applies it.
CREATE TABLE `project` (
  `id` text PRIMARY KEY,
  `worktree` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
CREATE TABLE `session` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `parent_id` text,
  `fork_session_id` text,
  `fork_boundary` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `path` text,
  `title` text,
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
  `time_archived` integer,
  `time_suspended` integer
);
CREATE TABLE `session_message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `type` text NOT NULL,
  `seq` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
CREATE TABLE `message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
CREATE TABLE `part` (
  `id` text PRIMARY KEY,
  `message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);

INSERT INTO `project` (`id`, `worktree`, `time_created`, `time_updated`)
VALUES ('prj_next', '/decant-fixture/example', 1791800000000, 1791800000000);

INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_next', 'prj_next', 'next', '/decant-fixture/example', 'Pre-split copy',
  '0.0.0-next-202607200000', 0.000005, 20, 4, 'build',
  '{"providerID":"opencode-go","id":"glm-5.3-flash"}', 1791800000000, 1791800004000);

INSERT INTO `session_message` (`id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data`) VALUES
('msg_next_1', 'ses_next', 'user', 1, 1791800000000, 1791800000000,
 '{"text":"hello","files":[],"time":{"created":1791800000000}}'),
('msg_next_2', 'ses_next', 'assistant', 2, 1791800001000, 1791800004000,
 '{"agent":"build","model":{"providerID":"opencode-go","id":"glm-5.3-flash"},"content":[{"type":"text","text":"Hello."}],"finish":"stop","cost":0.000005,"tokens":{"input":20,"output":4,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1791800001000,"completed":1791800004000}}');
