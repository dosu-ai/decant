-- Synthetic 1.x rows a reader must survive: a message whose data is not
-- JSON, an unknown part type, a part whose data is not JSON, a part whose
-- message does not exist, and an unknown message role.
-- Expected issues: unparsed_line ×3 (message, part, orphan part) and
-- unknown_record_type ×2 (part:hologram, role:narrator).
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`,
  `time_created`, `time_updated`)
VALUES ('ses_v1_bad', 'prj_v1', 'v1-bad', '/decant-fixture/example', 'Malformed rows', '1.18.35',
  1791797000000, 1791797060000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1b_1', 'ses_v1_bad', 1791797001000, 1791797001000, 'not json'),
('msg_v1b_2', 'ses_v1_bad', 1791797002000, 1791797002000,
 '{"role":"user","time":{"created":1791797002000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash"}}'),
('msg_v1b_3', 'ses_v1_bad', 1791797003000, 1791797003000,
 '{"role":"narrator","time":{"created":1791797003000}}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1b_1', 'msg_v1b_2', 'ses_v1_bad', 1791797002000, 1791797002000,
 '{"type":"hologram"}'),
('prt_v1b_2', 'msg_v1b_2', 'ses_v1_bad', 1791797002000, 1791797002000, 'nope'),
('prt_v1b_3', 'msg_v1b_missing', 'ses_v1_bad', 1791797004000, 1791797004000,
 '{"type":"text","text":"orphan"}');
