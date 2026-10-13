-- Synthetic database a 2.x build migrated: ses_shared exists in both the 1.x
-- tables and session_v2 (here the 1.x copy has the newer time_updated, as
-- when a 1.x binary keeps writing after the migration), and ses_v1_only
-- exists only in the 1.x tables. Needs schema.sql and v1/schema.sql, which
-- buildOpenCodeDb applies.
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES
('ses_shared', 'prj_v1', 'shared', '/decant-fixture/example', 'Legacy copy', '1.18.35',
  0, 0, 0, 0, 0, 0, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go"}',
  1791796000000, 1791799999999),
('ses_v1_only', 'prj_v1', 'v1-only', '/decant-fixture/example', 'Only in 1.x', '1.18.35',
  0.000009, 40, 6, 0, 0, 0, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go"}',
  1791796100000, 1791796160000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1m_1', 'ses_shared', 1791796000000, 1791796000000,
 '{"role":"user","time":{"created":1791796000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_v1u_1', 'ses_v1_only', 1791796100000, 1791796100000,
 '{"role":"user","time":{"created":1791796100000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_v1u_2', 'ses_v1_only', 1791796101000, 1791796103000,
 '{"role":"assistant","time":{"created":1791796101000,"completed":1791796103000},"parentID":"msg_v1u_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.000009,"tokens":{"total":46,"input":40,"output":6,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1m_01', 'msg_v1m_1', 'ses_shared', 1791796000000, 1791796000000,
 '{"type":"text","text":"hello"}'),
('prt_v1u_01', 'msg_v1u_1', 'ses_v1_only', 1791796100000, 1791796100000,
 '{"type":"text","text":"hello"}'),
('prt_v1u_02', 'msg_v1u_2', 'ses_v1_only', 1791796101000, 1791796101000,
 '{"type":"step-start"}'),
('prt_v1u_03', 'msg_v1u_2', 'ses_v1_only', 1791796102000, 1791796102500,
 '{"type":"text","text":"Hello.","time":{"start":1791796102000,"end":1791796102500}}'),
('prt_v1u_04', 'msg_v1u_2', 'ses_v1_only', 1791796103000, 1791796103000,
 '{"type":"step-finish","reason":"stop","cost":0.000009,"tokens":{"total":46,"input":40,"output":6,"reasoning":0,"cache":{"read":0,"write":0}}}');

INSERT INTO `session_v2` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_shared', 'prj_v1', 'shared', '/decant-fixture/example', 'Migrated copy', '1.18.35',
  0, 0, 0, 0, 0, 0, 'build',
  '{"providerID":"opencode-go","id":"glm-5.3-flash"}',
  1791796000000, 1791796000000);

INSERT INTO `session_message` (`id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1m_1', 'ses_shared', 'user', 0, 1791796000000, 1791796000000,
 '{"text":"hello","files":[],"time":{"created":1791796000000}}');

-- ses_migrated: a session the migrator copied and a 2.x build then continued,
-- so the 2.x copy is newer and wins. Created by 1.3.10, before OpenCode kept
-- reasoning out of output. msg_mg_2 made two requests (a read, then the
-- answer); 1.x kept only the second step's usage in its info.tokens, and the
-- migrator copied that, so the 2.x row reads 150 in / 30 out where the
-- step-finish parts sum to 250 / 50. The compaction request msg_mg_3 and its
-- summary msg_mg_4 became one 2.x compaction row without usage. msg_mg_5 and
-- msg_mg_6 were written by 2.x after the migration (disjoint tokens).
-- glm-5.3-flash list rates per 1M: input 0.15, output 0.5, cache read 0.03.
-- Recorded costs: step 1 = 100*0.15 + 20*0.5 = 25e-6; step 2 = 150*0.15 +
-- 30*0.5 + 100*0.03 = 40.5e-6; msg_mg_2 = 65.5e-6; summary = 300*0.15 +
-- 40*0.5 = 65e-6; msg_mg_6 = 60*0.15 + (8+4)*0.5 = 15e-6. The session_v2 and
-- 1.x aggregates sum last-step tokens, as the migrator and the 1.14.49
-- backfill computed them.
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES
('ses_migrated', 'prj_v1', 'migrated', '/decant-fixture/example', 'Migrated with steps', '1.3.10',
  0.0001305, 450, 70, 0, 100, 0, 'build', NULL, 1791797000000, 1791797030000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_mg_1', 'ses_migrated', 1791797000000, 1791797000000,
 '{"role":"user","time":{"created":1791797000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_mg_2', 'ses_migrated', 1791797001000, 1791797010000,
 '{"role":"assistant","time":{"created":1791797001000,"completed":1791797010000},"parentID":"msg_mg_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.0000655,"tokens":{"total":280,"input":150,"output":30,"reasoning":0,"cache":{"read":100,"write":0}},"finish":"stop"}'),
('msg_mg_3', 'ses_migrated', 1791797020000, 1791797020000,
 '{"role":"user","time":{"created":1791797020000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_mg_4', 'ses_migrated', 1791797021000, 1791797030000,
 '{"role":"assistant","time":{"created":1791797021000,"completed":1791797030000},"parentID":"msg_mg_3","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"compaction","agent":"compaction","summary":true,"path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.000065,"tokens":{"total":340,"input":300,"output":40,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_mg_01', 'msg_mg_1', 'ses_migrated', 1791797000000, 1791797000000,
 '{"type":"text","text":"hello"}'),
('prt_mg_02', 'msg_mg_2', 'ses_migrated', 1791797001000, 1791797001000,
 '{"type":"step-start"}'),
('prt_mg_03', 'msg_mg_2', 'ses_migrated', 1791797002000, 1791797004000,
 '{"type":"tool","callID":"call_mg_read","tool":"read","state":{"status":"completed","input":{"filePath":"/decant-fixture/example/notes.txt"},"output":"example notes","title":"notes.txt","metadata":{},"time":{"start":1791797002000,"end":1791797004000}}}'),
('prt_mg_04', 'msg_mg_2', 'ses_migrated', 1791797005000, 1791797005000,
 '{"type":"step-finish","reason":"tool-calls","cost":0.000025,"tokens":{"total":120,"input":100,"output":20,"reasoning":0,"cache":{"read":0,"write":0}}}'),
('prt_mg_05', 'msg_mg_2', 'ses_migrated', 1791797005000, 1791797005000,
 '{"type":"step-start"}'),
('prt_mg_06', 'msg_mg_2', 'ses_migrated', 1791797009000, 1791797009500,
 '{"type":"text","text":"Done.","time":{"start":1791797009000,"end":1791797009500}}'),
('prt_mg_07', 'msg_mg_2', 'ses_migrated', 1791797010000, 1791797010000,
 '{"type":"step-finish","reason":"stop","cost":0.0000405,"tokens":{"total":280,"input":150,"output":30,"reasoning":0,"cache":{"read":100,"write":0}}}'),
('prt_mg_08', 'msg_mg_3', 'ses_migrated', 1791797020000, 1791797020000,
 '{"type":"compaction","auto":false}'),
('prt_mg_09', 'msg_mg_4', 'ses_migrated', 1791797021000, 1791797021000,
 '{"type":"step-start"}'),
('prt_mg_10', 'msg_mg_4', 'ses_migrated', 1791797029000, 1791797029500,
 '{"type":"text","text":"Summary of the work so far.","time":{"start":1791797029000,"end":1791797029500}}'),
('prt_mg_11', 'msg_mg_4', 'ses_migrated', 1791797030000, 1791797030000,
 '{"type":"step-finish","reason":"stop","cost":0.000065,"tokens":{"total":340,"input":300,"output":40,"reasoning":0,"cache":{"read":0,"write":0}}}');

INSERT INTO `session_v2` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_migrated', 'prj_v1', 'migrated', '/decant-fixture/example', 'Migrated with steps',
  '1.3.10', 0.0001455, 510, 78, 4, 100, 0, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go","variant":"default"}',
  1791797000000, 1791797060000);

INSERT INTO `session_message` (`id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data`) VALUES
('msg_mg_1', 'ses_migrated', 'user', 0, 1791797000000, 1791797000000,
 '{"text":"hello","time":{"created":1791797000000}}'),
('msg_mg_2', 'ses_migrated', 'assistant', 1, 1791797001000, 1791797010000,
 '{"agent":"build","model":{"providerID":"opencode-go","id":"glm-5.3-flash","variant":"default"},"content":[{"type":"tool","id":"call_mg_read","name":"read","state":{"status":"completed","input":{"filePath":"/decant-fixture/example/notes.txt"},"content":[{"type":"text","text":"example notes"}],"metadata":{}},"time":{"created":1791797002000,"completed":1791797004000}},{"type":"text","text":"Done."}],"finish":"stop","cost":0.0000655,"tokens":{"input":150,"output":30,"reasoning":0,"cache":{"read":100,"write":0}},"time":{"created":1791797001000,"completed":1791797010000}}'),
('msg_mg_3', 'ses_migrated', 'compaction', 2, 1791797020000, 1791797030000,
 '{"status":"completed","reason":"manual","summary":"Summary of the work so far.","recent":"","time":{"created":1791797020000}}'),
('msg_mg_5', 'ses_migrated', 'user', 3, 1791797040000, 1791797040000,
 '{"text":"thanks","time":{"created":1791797040000}}'),
('msg_mg_6', 'ses_migrated', 'assistant', 4, 1791797050000, 1791797060000,
 '{"agent":"build","model":{"providerID":"opencode-go","id":"glm-5.3-flash","variant":"default"},"content":[{"type":"text","text":"Glad to help."}],"finish":"stop","cost":0.000015,"tokens":{"input":60,"output":8,"reasoning":4,"cache":{"read":0,"write":0}},"time":{"created":1791797050000,"completed":1791797060000}}');
