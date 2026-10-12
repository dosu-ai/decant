-- Synthetic 1.x reasoning semantics. ses_v1_old was written by 1.3.10, when
-- tokens.output already included reasoning and OpenCode charged reasoning a
-- second time (100×0.15 + 50×0.5 + 20×0.5 = 50e-6). msg_v1o_2 records the
-- provider total (input + output = 150, so reasoning is inside output);
-- msg_v1o_3 has no total, so the session version decides. ses_v1_new was
-- written by 1.4.0, where output excludes reasoning.
-- Expected: old output 100, reasoning 40, list cost 40e-6 per message
-- (recorded 50e-6 kept in raw); new output 50, reasoning 20, list cost 40e-6.
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES
('ses_v1_old', 'prj_v1', 'v1-old', '/decant-fixture/example', 'Think twice', '1.3.10',
  0.0001, 200, 100, 40, 0, 0, NULL, NULL,
  1791793000000, 1791793060000),
('ses_v1_new', 'prj_v1', 'v1-new', '/decant-fixture/example', 'Think once', '1.4.0',
  0.00004, 100, 30, 20, 0, 0, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go"}',
  1791793100000, 1791793160000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1o_1', 'ses_v1_old', 1791793000000, 1791793000000,
 '{"role":"user","time":{"created":1791793000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_v1o_2', 'ses_v1_old', 1791793001000, 1791793003000,
 '{"role":"assistant","time":{"created":1791793001000,"completed":1791793003000},"parentID":"msg_v1o_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.00005,"tokens":{"total":150,"input":100,"output":50,"reasoning":20,"cache":{"read":0,"write":0}},"finish":"stop"}'),
('msg_v1o_3', 'ses_v1_old', 1791793004000, 1791793006000,
 '{"role":"assistant","time":{"created":1791793004000,"completed":1791793006000},"parentID":"msg_v1o_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.00005,"tokens":{"input":100,"output":50,"reasoning":20,"cache":{"read":0,"write":0}},"finish":"stop"}'),
('msg_v1n_1', 'ses_v1_new', 1791793100000, 1791793100000,
 '{"role":"user","time":{"created":1791793100000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_v1n_2', 'ses_v1_new', 1791793101000, 1791793103000,
 '{"role":"assistant","time":{"created":1791793101000,"completed":1791793103000},"parentID":"msg_v1n_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.00004,"tokens":{"input":100,"output":30,"reasoning":20,"cache":{"read":0,"write":0}},"finish":"stop"}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1o_01', 'msg_v1o_1', 'ses_v1_old', 1791793000000, 1791793000000,
 '{"type":"text","text":"Think."}'),
('prt_v1o_02', 'msg_v1o_2', 'ses_v1_old', 1791793001000, 1791793001000,
 '{"type":"step-start"}'),
('prt_v1o_03', 'msg_v1o_2', 'ses_v1_old', 1791793001500, 1791793002000,
 '{"type":"reasoning","text":"Consider the example.","time":{"start":1791793001500,"end":1791793002000}}'),
('prt_v1o_04', 'msg_v1o_2', 'ses_v1_old', 1791793002500, 1791793002800,
 '{"type":"text","text":"Thought once.","time":{"start":1791793002500,"end":1791793002800}}'),
('prt_v1o_05', 'msg_v1o_2', 'ses_v1_old', 1791793003000, 1791793003000,
 '{"type":"step-finish","reason":"stop","cost":0.00005,"tokens":{"total":150,"input":100,"output":50,"reasoning":20,"cache":{"read":0,"write":0}}}'),
('prt_v1o_06', 'msg_v1o_3', 'ses_v1_old', 1791793004000, 1791793004000,
 '{"type":"step-start"}'),
('prt_v1o_07', 'msg_v1o_3', 'ses_v1_old', 1791793005000, 1791793005500,
 '{"type":"text","text":"Thought twice.","time":{"start":1791793005000,"end":1791793005500}}'),
('prt_v1o_08', 'msg_v1o_3', 'ses_v1_old', 1791793006000, 1791793006000,
 '{"type":"step-finish","reason":"stop","cost":0.00005,"tokens":{"input":100,"output":50,"reasoning":20,"cache":{"read":0,"write":0}}}'),
('prt_v1n_01', 'msg_v1n_1', 'ses_v1_new', 1791793100000, 1791793100000,
 '{"type":"text","text":"Think."}'),
('prt_v1n_02', 'msg_v1n_2', 'ses_v1_new', 1791793101000, 1791793101000,
 '{"type":"step-start"}'),
('prt_v1n_03', 'msg_v1n_2', 'ses_v1_new', 1791793101500, 1791793102000,
 '{"type":"reasoning","text":"Consider the example.","time":{"start":1791793101500,"end":1791793102000}}'),
('prt_v1n_04', 'msg_v1n_2', 'ses_v1_new', 1791793102500, 1791793102800,
 '{"type":"text","text":"Thought once.","time":{"start":1791793102500,"end":1791793102800}}'),
('prt_v1n_05', 'msg_v1n_2', 'ses_v1_new', 1791793103000, 1791793103000,
 '{"type":"step-finish","reason":"stop","cost":0.00004,"tokens":{"input":100,"output":30,"reasoning":20,"cache":{"read":0,"write":0}}}');
