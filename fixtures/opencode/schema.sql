-- Synthetic OpenCode 2.x storage: the tables Decant reads, mirroring the DDL
-- of anomalyco/opencode v2.0.27 minus the project foreign key. Applied before
-- every session script in fixtures/opencode/.
CREATE TABLE `kv` (
  `key` text PRIMARY KEY,
  `value` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
CREATE TABLE `session_v2` (
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
  `time_idle` integer,
  `time_viewed` integer,
  `idle_outcome` text,
  `time_compacting` integer,
  `time_archived` integer,
  `time_suspended` integer,
  `resume_attempts` integer DEFAULT 0 NOT NULL
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
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`, `seq`);
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`, `time_created`, `id`);
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`, `type`, `seq`);

-- models.dev catalog cache in OpenCode's shape: `body` is a JSON string keyed
-- provider -> models -> model id -> { limit, cost }.
INSERT INTO `kv` (`key`, `value`, `time_created`, `time_updated`) VALUES (
  'models-dev:catalog',
  json_object(
    'updatedAt', 1791786000000,
    'digest', 'synthetic',
    'body', '{"opencode-go":{"models":{"glm-5.3-flash":{"limit":{"context":1000000,"output":131072},"cost":{"input":0.15,"output":0.5,"cache_read":0.03}}}},"openrouter":{"models":{"meta/muse-wonder":{"limit":{"context":1048576,"output":943718},"cost":{"input":4,"output":20,"cache_read":0.2}}}},"example":{"models":{"example-unpriced":{"limit":{"context":64000,"output":8192}}}}}'
  ),
  1791786000000, 1791786000000
);
