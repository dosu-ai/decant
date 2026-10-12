-- Synthetic 1.x subagent: the parent's `task` tool part names the child in
-- state.metadata.sessionId (lowercase d, as 1.x writes it), and the child
-- session points back through parent_id.
INSERT INTO `session` (`id`, `project_id`, `parent_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES
('ses_v1_parent', 'prj_v1', NULL, 'v1-parent', '/decant-fixture/example', 'List the example files', '1.18.35',
  0.000017, 80, 10, 0, 0, 0, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go","variant":"max"}',
  1791792000000, 1791792060000),
('ses_v1_child', 'prj_v1', 'ses_v1_parent', 'v1-child', '/decant-fixture/example', 'List files (@explore subagent)', '1.18.35',
  0.000011, 60, 4, 0, 0, 0, 'explore',
  '{"id":"glm-5.3-flash","providerID":"opencode-go","variant":"max"}',
  1791792002000, 1791792004000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1p_1', 'ses_v1_parent', 1791792000000, 1791792000000,
 '{"role":"user","time":{"created":1791792000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}'),
('msg_v1p_2', 'ses_v1_parent', 1791792001000, 1791792005000,
 '{"role":"assistant","time":{"created":1791792001000,"completed":1791792005000},"parentID":"msg_v1p_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.000017,"tokens":{"total":90,"input":80,"output":10,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"max","finish":"tool-calls"}'),
('msg_v1k_1', 'ses_v1_child', 1791792002000, 1791792002000,
 '{"role":"user","time":{"created":1791792002000},"agent":"explore","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}'),
('msg_v1k_2', 'ses_v1_child', 1791792002500, 1791792003500,
 '{"role":"assistant","time":{"created":1791792002500,"completed":1791792003500},"parentID":"msg_v1k_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"explore","agent":"explore","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.000011,"tokens":{"total":64,"input":60,"output":4,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"max","finish":"stop"}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1p_01', 'msg_v1p_1', 'ses_v1_parent', 1791792000000, 1791792000000,
 '{"type":"text","text":"List the example files."}'),
('prt_v1p_02', 'msg_v1p_2', 'ses_v1_parent', 1791792001000, 1791792001000,
 '{"type":"step-start","snapshot":"snap0"}'),
('prt_v1p_03', 'msg_v1p_2', 'ses_v1_parent', 1791792001000, 1791792004000,
 '{"type":"tool","callID":"call_v1_task","tool":"task","state":{"status":"completed","input":{"description":"List files","prompt":"List the files in /decant-fixture/example","subagent_type":"explore"},"output":"notes.txt","title":"List files","metadata":{"sessionId":"ses_v1_child","parentSessionId":"ses_v1_parent"},"time":{"start":1791792001000,"end":1791792004000}}}'),
('prt_v1p_04', 'msg_v1p_2', 'ses_v1_parent', 1791792005000, 1791792005000,
 '{"type":"step-finish","reason":"tool-calls","snapshot":"snap1","cost":0.000017,"tokens":{"total":90,"input":80,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}'),
('prt_v1k_01', 'msg_v1k_1', 'ses_v1_child', 1791792002000, 1791792002000,
 '{"type":"text","text":"List the files in /decant-fixture/example"}'),
('prt_v1k_02', 'msg_v1k_2', 'ses_v1_child', 1791792002500, 1791792002500,
 '{"type":"step-start","snapshot":"snap0"}'),
('prt_v1k_03', 'msg_v1k_2', 'ses_v1_child', 1791792003000, 1791792003200,
 '{"type":"text","text":"notes.txt","time":{"start":1791792003000,"end":1791792003200}}'),
('prt_v1k_04', 'msg_v1k_2', 'ses_v1_child', 1791792003500, 1791792003500,
 '{"type":"step-finish","reason":"stop","snapshot":"snap0","cost":0.000011,"tokens":{"total":64,"input":60,"output":4,"reasoning":0,"cache":{"read":0,"write":0}}}');
