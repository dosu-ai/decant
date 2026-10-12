-- Synthetic 1.x compaction: a user message holding a `compaction` part, then
-- the `summary: true` assistant that answers it (parentID = that user
-- message), which carries the compaction request's own cost and tokens.
-- Expected: roles user, assistant, system, user; the system message has
-- raw.type "compaction", raw.cost 0.000065, usage input 300 output 40, text
-- "Summary of earlier work."; totals input 400, output 80.
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_v1_compact', 'prj_v1', 'v1-compact', '/decant-fixture/example', 'Compaction example', '1.18.35',
  0.0001, 400, 80, 0, 0, 0, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go","variant":"max"}',
  1791791000000, 1791791060000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1c_1', 'ses_v1_compact', 1791791000000, 1791791000000,
 '{"role":"user","time":{"created":1791791000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}'),
('msg_v1c_2', 'ses_v1_compact', 1791791001000, 1791791004000,
 '{"role":"assistant","time":{"created":1791791001000,"completed":1791791004000},"parentID":"msg_v1c_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.000035,"tokens":{"total":140,"input":100,"output":40,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"max","finish":"stop"}'),
('msg_v1c_3', 'ses_v1_compact', 1791791010000, 1791791010000,
 '{"role":"user","time":{"created":1791791010000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}'),
('msg_v1c_4', 'ses_v1_compact', 1791791011000, 1791791015000,
 '{"role":"assistant","time":{"created":1791791011000,"completed":1791791015000},"parentID":"msg_v1c_3","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"compaction","agent":"compaction","summary":true,"path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.000065,"tokens":{"total":340,"input":300,"output":40,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"max","finish":"stop"}'),
('msg_v1c_5', 'ses_v1_compact', 1791791020000, 1791791020000,
 '{"role":"user","time":{"created":1791791020000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1c_01', 'msg_v1c_1', 'ses_v1_compact', 1791791000000, 1791791000000,
 '{"type":"text","text":"Keep going."}'),
('prt_v1c_02', 'msg_v1c_2', 'ses_v1_compact', 1791791001000, 1791791001000,
 '{"type":"step-start","snapshot":"snap0"}'),
('prt_v1c_03', 'msg_v1c_2', 'ses_v1_compact', 1791791002000, 1791791003000,
 '{"type":"text","text":"Done.","time":{"start":1791791002000,"end":1791791003000}}'),
('prt_v1c_04', 'msg_v1c_2', 'ses_v1_compact', 1791791004000, 1791791004000,
 '{"type":"step-finish","reason":"stop","snapshot":"snap1","cost":0.000035,"tokens":{"total":140,"input":100,"output":40,"reasoning":0,"cache":{"read":0,"write":0}}}'),
('prt_v1c_05', 'msg_v1c_3', 'ses_v1_compact', 1791791010000, 1791791010000,
 '{"type":"compaction","auto":true,"overflow":true}'),
('prt_v1c_06', 'msg_v1c_4', 'ses_v1_compact', 1791791011000, 1791791011000,
 '{"type":"step-start","snapshot":"snap1"}'),
('prt_v1c_07', 'msg_v1c_4', 'ses_v1_compact', 1791791012000, 1791791014000,
 '{"type":"text","text":"Summary of earlier work.","time":{"start":1791791012000,"end":1791791014000}}'),
('prt_v1c_08', 'msg_v1c_4', 'ses_v1_compact', 1791791015000, 1791791015000,
 '{"type":"step-finish","reason":"stop","snapshot":"snap1","cost":0.000065,"tokens":{"total":340,"input":300,"output":40,"reasoning":0,"cache":{"read":0,"write":0}}}'),
('prt_v1c_09', 'msg_v1c_5', 'ses_v1_compact', 1791791020000, 1791791020000,
 '{"type":"text","text":"Continue."}');
