-- Synthetic session with an MCP tool, a web search, a failed web fetch, and
-- a model served through OpenRouter.
INSERT INTO `session_v2` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_mcp', 'prj_sample', 'mcp', '/tmp/example', 'Search the knowledge base', '2.0.27',
  0.0108, 2200, 70, 25, 500, 0, 'build',
  '{"providerID":"openrouter","id":"meta/muse-wonder","variant":"high"}',
  1791789600000, 1791789660000);

INSERT INTO `session_message` (`id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data`) VALUES
('msg_mcp_1', 'ses_mcp', 'user', 1, 1791789600000, 1791789600000,
 '{"text":"Search the knowledge base for the example topic.","files":[],"time":{"created":1791789600000}}'),
('msg_mcp_2', 'ses_mcp', 'assistant', 2, 1791789601000, 1791789604000,
 '{"agent":"build","model":{"providerID":"openrouter","id":"meta/muse-wonder","variant":"high"},"content":[{"type":"tool","id":"call_mcp_1","name":"dosu_search_knowledge","executed":false,"state":{"status":"completed","input":{"query":"example topic"},"content":[{"type":"text","text":"example result"}],"metadata":{"truncated":false}},"time":{"created":1791789601000,"ran":1791789601500,"completed":1791789602000}},{"type":"tool","id":"call_web_1","name":"websearch","executed":false,"state":{"status":"completed","input":{"query":"example topic"},"content":[{"type":"text","text":"example page"}],"metadata":{"provider":"synthetic","truncated":false}},"time":{"created":1791789602000,"ran":1791789602500,"completed":1791789603000}}],"finish":"tool-calls","cost":0.0056,"tokens":{"input":1000,"output":50,"reasoning":25,"cache":{"read":500,"write":0}},"time":{"created":1791789601000,"completed":1791789604000}}'),
('msg_mcp_3', 'ses_mcp', 'assistant', 3, 1791789605000, 1791789607000,
 '{"agent":"build","model":{"providerID":"openrouter","id":"meta/muse-wonder","variant":"high"},"content":[{"type":"tool","id":"call_fetch_1","name":"webfetch","executed":false,"state":{"status":"error","input":{"url":"https://example.invalid/page","format":"markdown"},"error":{"type":"tool.failed","message":"fetch failed"}},"time":{"created":1791789605000,"ran":1791789605500,"completed":1791789606000}},{"type":"text","text":"The knowledge base covers the example topic; the page could not be fetched."}],"finish":"stop","cost":0.0052,"tokens":{"input":1200,"output":20,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1791789605000,"completed":1791789607000}}'),
('msg_mcp_4', 'ses_mcp', 'idle', 4, 1791789607000, 1791789607000,
 '{"outcome":"succeeded","time":{"created":1791789607000}}');
