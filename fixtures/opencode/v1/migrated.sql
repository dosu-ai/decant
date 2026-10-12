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
