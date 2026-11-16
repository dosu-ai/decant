-- Synthetic subagent run spawned by `delegate_task` in fixtures/hermes/sample.sql.
-- Its parent ended with `cli_close`, not a compression, reset, or branch, so
-- it is a subagent. Hermes records no tool-call link back to the spawn.
INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason,
  message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, cwd, title, api_call_count, profile_name)
VALUES ('20261101_090110_d4e5f6', 'cli', 'gpt-5.4-mini', '20261101_090000_a1b2c3',
  1791786070.0, 1791786099.0, 'subagent_done', 4, 1, 400, 30, 200, 0, 0,
  '/decant-fixture/example', 'Count the lines in notes.txt', 2, 'default');

INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name,
  timestamp, finish_reason, active, compacted, message_uid) VALUES
(101, '20261101_090110_d4e5f6', 'user', 'Count the lines in notes.txt', NULL, NULL, NULL,
  1791786070.0, NULL, 1, 0, 'uid-sub-user-1'),
(102, '20261101_090110_d4e5f6', 'assistant', NULL, NULL,
  '[{"id":"call_wc_1","type":"function","function":{"name":"terminal","arguments":"{\"command\":\"wc -l notes.txt\"}"}}]',
  NULL, 1791786080.0, 'tool_calls', 1, 0, 'uid-sub-assistant-2'),
(103, '20261101_090110_d4e5f6', 'tool', '{"output":"3 notes.txt","exit_code":0}', 'call_wc_1',
  NULL, 'terminal', 1791786081.0, NULL, 1, 0, 'uid-sub-tool-3'),
(104, '20261101_090110_d4e5f6', 'assistant', 'notes.txt has 3 lines.', NULL, NULL, NULL,
  1791786099.0, 'stop', 1, 0, 'uid-sub-assistant-4');

INSERT INTO session_model_usage (session_id, model, billing_provider, billing_mode, task,
  api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens) VALUES
('20261101_090110_d4e5f6', 'gpt-5.4-mini', 'openrouter', 'api', '', 2, 400, 30, 200, 0, 0);
