-- Synthetic 1.x fork of the v1-sample session. 1.x records no fork link:
-- Session.fork copies the parent's messages with new ids but their original
-- time.created, so msg_v1f_1 and msg_v1f_2 predate the fork session. The
-- session aggregates include that inherited usage, as OpenCode's projector
-- counts the copied step-finish parts.
-- Expected: fork_rows_skipped 2; totals input 90, output 10; the first
-- emitted message is "Try again.".
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_v1_fork', 'prj_v1', 'v1-fork', '/decant-fixture/example', 'Read the example notes (fork #1)', '1.18.35',
  0.0000601, 210, 40, 10, 40, 16, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go","variant":"max"}',
  1791795000000, 1791795060000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1f_1', 'ses_v1_fork', 1791790000000, 1791790000000,
 '{"role":"user","time":{"created":1791790000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}'),
('msg_v1f_2', 'ses_v1_fork', 1791790001000, 1791790005000,
 '{"role":"assistant","time":{"created":1791790001000,"completed":1791790005000},"parentID":"msg_v1f_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.0000416,"tokens":{"total":216,"input":120,"output":30,"reasoning":10,"cache":{"read":40,"write":16}},"variant":"max","finish":"stop"}'),
('msg_v1f_3', 'ses_v1_fork', 1791795001000, 1791795001000,
 '{"role":"user","time":{"created":1791795001000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}'),
('msg_v1f_4', 'ses_v1_fork', 1791795002000, 1791795004000,
 '{"role":"assistant","time":{"created":1791795002000,"completed":1791795004000},"parentID":"msg_v1f_3","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.0000185,"tokens":{"total":100,"input":90,"output":10,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"max","finish":"stop"}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1f_01', 'msg_v1f_1', 'ses_v1_fork', 1791790000000, 1791790000000,
 '{"type":"text","text":"Read the example notes and search the docs."}'),
('prt_v1f_02', 'msg_v1f_2', 'ses_v1_fork', 1791790001000, 1791790001000,
 '{"type":"step-start","snapshot":"snap0"}'),
('prt_v1f_03', 'msg_v1f_2', 'ses_v1_fork', 1791790004000, 1791790004500,
 '{"type":"text","text":"The notes say hello.","time":{"start":1791790004000,"end":1791790004500}}'),
('prt_v1f_04', 'msg_v1f_2', 'ses_v1_fork', 1791790005000, 1791790005000,
 '{"type":"step-finish","reason":"stop","snapshot":"snap1","cost":0.0000416,"tokens":{"total":216,"input":120,"output":30,"reasoning":10,"cache":{"read":40,"write":16}}}'),
('prt_v1f_05', 'msg_v1f_3', 'ses_v1_fork', 1791795001000, 1791795001000,
 '{"type":"text","text":"Try again."}'),
('prt_v1f_06', 'msg_v1f_4', 'ses_v1_fork', 1791795002000, 1791795002000,
 '{"type":"step-start","snapshot":"snap1"}'),
('prt_v1f_07', 'msg_v1f_4', 'ses_v1_fork', 1791795003000, 1791795003500,
 '{"type":"text","text":"The notes still say hello.","time":{"start":1791795003000,"end":1791795003500}}'),
('prt_v1f_08', 'msg_v1f_4', 'ses_v1_fork', 1791795004000, 1791795004000,
 '{"type":"step-finish","reason":"stop","snapshot":"snap2","cost":0.0000185,"tokens":{"total":100,"input":90,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}');
