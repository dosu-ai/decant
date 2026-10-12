-- Synthetic session for the v1.2.0 table shape (v1/schema-1.2.sql): no
-- cost, tokens_*, agent, or model columns, so the session model comes from
-- the assistant row. The assistant has no step-finish parts, so its usage is
-- info.tokens, and 1.2.0 recorded output including reasoning.
-- Expected: output 50, reasoning 20.
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`,
  `time_created`, `time_updated`)
VALUES ('ses_v1_12', 'prj_v1', 'v1-12', '/decant-fixture/example', 'Old shape', '1.2.0',
  1791798000000, 1791798060000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1t_1', 'ses_v1_12', 1791798000000, 1791798000000,
 '{"role":"user","time":{"created":1791798000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_v1t_2', 'ses_v1_12', 1791798001000, 1791798003000,
 '{"role":"assistant","time":{"created":1791798001000,"completed":1791798003000},"parentID":"msg_v1t_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.00005,"tokens":{"input":100,"output":50,"reasoning":20,"cache":{"read":0,"write":0}},"finish":"stop"}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1t_01', 'msg_v1t_1', 'ses_v1_12', 1791798000000, 1791798000000,
 '{"type":"text","text":"Hi."}'),
('prt_v1t_02', 'msg_v1t_2', 'ses_v1_12', 1791798002000, 1791798002500,
 '{"type":"text","text":"Hello.","time":{"start":1791798002000,"end":1791798002500}}');
