-- Synthetic CLI session. The first turn was archived by an in-place
-- compaction (active 0, compacted 1), which wrote a summary row and re-inserted
-- the protected tail (the second prompt) as a live copy. A rewound draft
-- (active 0, compacted 0) is not part of the transcript. The second turn runs
-- a shell command, an MCP tool through a Codex Responses bridge ID, a
-- delegated subagent (fixtures/hermes/subagent.sql), and a file patch. Usage
-- is recorded per model: the main model plus a title-generation route.
INSERT INTO sessions (id, source, model, model_config, system_prompt, started_at, ended_at,
  end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, cwd, git_branch, git_repo_root, billing_provider,
  billing_mode, estimated_cost_usd, cost_status, title, last_activity_at, api_call_count,
  profile_name)
VALUES ('20261101_090000_a1b2c3', 'cli', 'anthropic/claude-sonnet-5-5',
  '{"max_iterations":90}', 'You are an example assistant.', 1791786000.0, 1791786130.5,
  'cli_close', 15, 5, 1020, 252, 3000, 400, 60, '/decant-fixture/example', 'main',
  '/decant-fixture/example', 'openrouter', 'api', 0.0123, 'estimated',
  'Summarize the example notes', 1791786130.5, 4, 'default');

INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name,
  timestamp, finish_reason, reasoning, reasoning_content, _compressed_summary, active,
  compacted, message_uid) VALUES
(1, '20261101_090000_a1b2c3', 'user',
  char(0) || 'json:[{"type":"text","text":"Read notes.txt and summarize it."},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]',
  NULL, NULL, NULL, 1791786000.0, NULL, NULL, NULL, 0, 0, 1, 'uid-user-1'),
(2, '20261101_090000_a1b2c3', 'assistant', '', NULL,
  '[{"id":"call_read_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes.txt\"}"}}]',
  NULL, 1791786004.0, 'tool_calls', 'Read the file before answering.', NULL, 0, 0, 1,
  'uid-assistant-2'),
(3, '20261101_090000_a1b2c3', 'tool', 'hello from the example notes', 'call_read_1', NULL,
  'read_file', 1791786005.0, NULL, NULL, NULL, 0, 0, 1, 'uid-tool-3'),
(4, '20261101_090000_a1b2c3', 'assistant', 'The notes say hello.', NULL, NULL, NULL,
  1791786008.0, 'stop', NULL, NULL, 0, 0, 1, 'uid-assistant-4'),
(5, '20261101_090000_a1b2c3', 'user', 'Now list the files, search the docs, and update the notes.',
  NULL, NULL, NULL, 1791786060.0, NULL, NULL, NULL, 0, 0, 1, 'uid-user-5'),
(6, '20261101_090000_a1b2c3', 'user',
  '[Summary of earlier turns] The user asked for a summary of notes.txt, which says hello.',
  NULL, NULL, NULL, 1791786061.0, NULL, NULL, NULL, 1, 1, 0, 'uid-summary-6'),
(7, '20261101_090000_a1b2c3', 'user', 'Now list the files, search the docs, and update the notes.',
  NULL, NULL, NULL, 1791786060.0, NULL, NULL, NULL, 0, 1, 0, 'uid-user-5'),
(8, '20261101_090000_a1b2c3', 'assistant', NULL, NULL,
  '[{"id":"call_ls_1|rs_item_1","call_id":"call_ls_1","type":"function","function":{"name":"terminal","arguments":"{\"command\":\"ls\"}"}},{"id":"call_docs_1","type":"function","function":{"name":"mcp_docs_search_pages","arguments":"{\"query\":\"hello\"}"}},{"id":"call_delegate_1","type":"function","function":{"name":"delegate_task","arguments":"{\"goal\":\"Count the lines in notes.txt\"}"}}]',
  NULL, 1791786066.0, 'tool_calls', NULL, 'List the files, then search the docs.', 0, 1, 0,
  'uid-assistant-8'),
(9, '20261101_090000_a1b2c3', 'tool', '{"output":"README.md\nnotes.txt","exit_code":0}',
  'call_ls_1', NULL, 'terminal', 1791786067.0, NULL, NULL, NULL, 0, 1, 0, 'uid-tool-9'),
(10, '20261101_090000_a1b2c3', 'tool',
  char(0) || 'json:[{"type":"text","text":"Found 1 page: Getting started."}]',
  'call_docs_1', NULL, 'mcp_docs_search_pages', 1791786068.0, NULL, NULL, NULL, 0, 1, 0,
  'uid-tool-10'),
(11, '20261101_090000_a1b2c3', 'tool', '{"summary":"notes.txt has 3 lines."}',
  'call_delegate_1', NULL, 'delegate_task', 1791786100.0, NULL, NULL, NULL, 0, 1, 0,
  'uid-tool-11'),
(12, '20261101_090000_a1b2c3', 'assistant', 'Updating the notes now.', NULL,
  '[{"id":"call_patch_1","type":"function","function":{"name":"patch","arguments":"{\"path\":\"/decant-fixture/example/notes.txt\",\"old_string\":\"hello\",\"new_string\":\"hello, world\"}"}}]',
  NULL, 1791786110.0, 'tool_calls', NULL, NULL, 0, 1, 0, 'uid-assistant-12'),
(13, '20261101_090000_a1b2c3', 'tool', '{"success":true}', 'call_patch_1', NULL, 'patch',
  1791786111.0, NULL, NULL, NULL, 0, 1, 0, 'uid-tool-13'),
(14, '20261101_090000_a1b2c3', 'assistant', 'A draft answer that was rewound.', NULL, NULL, NULL,
  1791786115.0, 'stop', NULL, NULL, 0, 0, 0, 'uid-assistant-14'),
(15, '20261101_090000_a1b2c3', 'assistant',
  'Listed two files, found one docs page, counted 3 lines, and updated notes.txt.', NULL, NULL,
  NULL, 1791786130.0, 'stop', NULL, NULL, 0, 1, 0, 'uid-assistant-15');

INSERT INTO session_model_usage (session_id, model, billing_provider, billing_mode, task,
  api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, estimated_cost_usd, cost_status, first_seen, last_seen) VALUES
('20261101_090000_a1b2c3', 'anthropic/claude-sonnet-5-5', 'openrouter', 'api', '', 3, 900,
  240, 3000, 400, 60, 0.0121, 'estimated', 1791786004.0, 1791786130.0),
('20261101_090000_a1b2c3', 'gpt-5.4-mini', 'openrouter', 'api', 'title_generation', 1, 120, 12,
  0, 0, 0, 0.0002, 'estimated', 1791786001.0, 1791786001.0);
