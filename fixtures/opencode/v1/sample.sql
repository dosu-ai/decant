-- Synthetic 1.x-only session (version 1.18.35). Pins: synthetic user text
-- becomes a system message, a file part an image block, `filePath` inputs,
-- MCP naming (`dosu_search`), a failed bash call, a two-step message whose
-- info.tokens holds only the last step, a retry part, and an unfinished
-- message with a pending tool.
-- Expected Decant totals: input 370, output 57 (47 + reasoning 10),
-- reasoning 10, cacheRead 100, cacheCreation 16; list cost 0.0000894.
INSERT INTO `session` (`id`, `project_id`, `slug`, `directory`, `title`, `version`, `cost`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`,
  `agent`, `model`, `time_created`, `time_updated`)
VALUES ('ses_v1_sample', 'prj_v1', 'v1-sample', '/decant-fixture/example', 'Read the example notes', '1.18.35',
  0.0000894, 370, 47, 10, 100, 16, 'build',
  '{"id":"glm-5.3-flash","providerID":"opencode-go","variant":"max"}',
  1791790000000, 1791790060000);

INSERT INTO `message` (`id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('msg_v1s_1', 'ses_v1_sample', 1791790000000, 1791790000000,
 '{"role":"user","time":{"created":1791790000000},"agent":"build","model":{"providerID":"opencode-go","modelID":"glm-5.3-flash","variant":"max"}}'),
('msg_v1s_2', 'ses_v1_sample', 1791790001000, 1791790005000,
 '{"role":"assistant","time":{"created":1791790001000,"completed":1791790005000},"parentID":"msg_v1s_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.0000416,"tokens":{"total":216,"input":120,"output":30,"reasoning":10,"cache":{"read":40,"write":16}},"variant":"max","finish":"tool-calls"}'),
('msg_v1s_3', 'ses_v1_sample', 1791790006000, 1791790009000,
 '{"role":"assistant","time":{"created":1791790006000,"completed":1791790009000},"parentID":"msg_v1s_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0.0000478,"tokens":{"total":272,"input":200,"output":12,"reasoning":0,"cache":{"read":60,"write":0}},"variant":"max","finish":"stop"}'),
('msg_v1s_4', 'ses_v1_sample', 1791790010000, 1791790010000,
 '{"role":"assistant","time":{"created":1791790010000},"parentID":"msg_v1s_1","modelID":"glm-5.3-flash","providerID":"opencode-go","mode":"build","agent":"build","path":{"cwd":"/decant-fixture/example","root":"/decant-fixture/example"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"max"}');

INSERT INTO `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`) VALUES
('prt_v1s_01', 'msg_v1s_1', 'ses_v1_sample', 1791790000000, 1791790000000,
 '{"type":"text","text":"Read the example notes and search the docs."}'),
('prt_v1s_02', 'msg_v1s_1', 'ses_v1_sample', 1791790000000, 1791790000000,
 '{"type":"text","text":"Called the Read tool on notes.txt","synthetic":true}'),
('prt_v1s_03', 'msg_v1s_1', 'ses_v1_sample', 1791790000000, 1791790000000,
 '{"type":"file","mime":"text/plain","filename":"notes.txt","url":"file:///decant-fixture/example/notes.txt"}'),
('prt_v1s_04', 'msg_v1s_2', 'ses_v1_sample', 1791790001000, 1791790001000,
 '{"type":"step-start","snapshot":"snap0"}'),
('prt_v1s_05', 'msg_v1s_2', 'ses_v1_sample', 1791790001100, 1791790001500,
 '{"type":"reasoning","text":"Read the file first.","time":{"start":1791790001100,"end":1791790001500}}'),
('prt_v1s_06', 'msg_v1s_2', 'ses_v1_sample', 1791790002000, 1791790002500,
 '{"type":"tool","callID":"call_v1_read","tool":"read","state":{"status":"completed","input":{"filePath":"/decant-fixture/example/notes.txt"},"output":"hello","title":"notes.txt","metadata":{},"time":{"start":1791790002000,"end":1791790002500}}}'),
('prt_v1s_07', 'msg_v1s_2', 'ses_v1_sample', 1791790003000, 1791790003500,
 '{"type":"tool","callID":"call_v1_mcp","tool":"dosu_search","state":{"status":"completed","input":{"query":"example"},"output":"no results","title":"search","metadata":{},"time":{"start":1791790003000,"end":1791790003500}}}'),
('prt_v1s_08', 'msg_v1s_2', 'ses_v1_sample', 1791790005000, 1791790005000,
 '{"type":"step-finish","reason":"tool-calls","snapshot":"snap1","cost":0.0000416,"tokens":{"total":216,"input":120,"output":30,"reasoning":10,"cache":{"read":40,"write":16}}}'),
('prt_v1s_09', 'msg_v1s_3', 'ses_v1_sample', 1791790006000, 1791790006000,
 '{"type":"step-start","snapshot":"snap1"}'),
('prt_v1s_10', 'msg_v1s_3', 'ses_v1_sample', 1791790006500, 1791790006500,
 '{"type":"step-finish","reason":"unknown","cost":0.00001,"tokens":{"total":55,"input":50,"output":5,"reasoning":0,"cache":{"read":0,"write":0}}}'),
('prt_v1s_11', 'msg_v1s_3', 'ses_v1_sample', 1791790007000, 1791790007000,
 '{"type":"retry","attempt":1,"error":{"name":"APIError","data":{"message":"overloaded","isRetryable":true}},"time":{"created":1791790007000}}'),
('prt_v1s_12', 'msg_v1s_3', 'ses_v1_sample', 1791790007500, 1791790007500,
 '{"type":"step-start","snapshot":"snap1"}'),
('prt_v1s_13', 'msg_v1s_3', 'ses_v1_sample', 1791790008000, 1791790008500,
 '{"type":"text","text":"The notes say hello.","time":{"start":1791790008000,"end":1791790008500}}'),
('prt_v1s_14', 'msg_v1s_3', 'ses_v1_sample', 1791790008600, 1791790008700,
 '{"type":"tool","callID":"call_v1_bash","tool":"bash","state":{"status":"error","input":{"command":"cat /decant-fixture/example/missing.txt"},"error":"No such file or directory","time":{"start":1791790008600,"end":1791790008700}}}'),
('prt_v1s_15', 'msg_v1s_3', 'ses_v1_sample', 1791790009000, 1791790009000,
 '{"type":"step-finish","reason":"stop","cost":0.0000378,"tokens":{"total":272,"input":200,"output":12,"reasoning":0,"cache":{"read":60,"write":0}}}'),
('prt_v1s_16', 'msg_v1s_4', 'ses_v1_sample', 1791790010000, 1791790010000,
 '{"type":"tool","callID":"call_v1_pending","tool":"read","state":{"status":"pending","input":{},"raw":""}}');
