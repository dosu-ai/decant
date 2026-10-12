-- Synthetic session: one prompt, a `read` tool call with reasoning, a reply.
INSERT INTO `session_v2` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_sample', 'prj_sample', 'sample', '/decant-fixture/example', 'Summarize the example file', '2.0.27',
  0.0000794, 320, 42, 10, 100, 16, 'build',
  '{"providerID":"opencode-go","id":"glm-5.3-flash","variant":"max"}',
  1791786000000, 1791786060000);

INSERT INTO `session_message` (`id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data`) VALUES
('msg_sample_1', 'ses_sample', 'user', 1, 1791786000000, 1791786000000,
 '{"text":"Read the example file and summarize it.","files":[],"time":{"created":1791786000000}}'),
('msg_sample_2', 'ses_sample', 'assistant', 2, 1791786001000, 1791786005000,
 '{"agent":"build","model":{"providerID":"opencode-go","id":"glm-5.3-flash","variant":"max"},"content":[{"type":"reasoning","text":"Read the file before answering.","time":{"created":1791786001000,"completed":1791786002000}},{"type":"tool","id":"call_read_1","name":"read","executed":false,"state":{"status":"completed","input":{"path":"/decant-fixture/example/notes.txt"},"content":[{"type":"text","text":"hello"}],"metadata":{"truncated":false}},"time":{"created":1791786002000,"ran":1791786002500,"completed":1791786003000}}],"finish":"tool-calls","cost":0.0000416,"tokens":{"input":120,"output":30,"reasoning":10,"cache":{"read":40,"write":16}},"time":{"created":1791786001000,"completed":1791786005000}}'),
('msg_sample_3', 'ses_sample', 'assistant', 3, 1791786006000, 1791786008000,
 '{"agent":"build","model":{"providerID":"opencode-go","id":"glm-5.3-flash","variant":"max"},"content":[{"type":"text","text":"The file says hello."}],"finish":"stop","cost":0.0000378,"tokens":{"input":200,"output":12,"reasoning":0,"cache":{"read":60,"write":0}},"time":{"created":1791786006000,"completed":1791786008000}}'),
('msg_sample_4', 'ses_sample', 'idle', 4, 1791786008000, 1791786008000,
 '{"outcome":"succeeded","time":{"created":1791786008000}}');
