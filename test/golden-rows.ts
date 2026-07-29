/** Natural-key row snapshots shared by the parity test and golden regenerator. */
export const ROW_QUERIES = {
  sessions: `
    SELECT s.tool, s.source_session_id, p.path AS project_path, p.name AS project_name,
           s.title, s.cwd, s.git_branch, s.model, s.cli_version, s.started_at, s.ended_at,
           s.message_count, s.total_input_tokens, s.total_output_tokens,
           s.total_cache_read_tokens, s.total_cache_creation_tokens,
           s.total_reasoning_tokens, s.est_reasoning_tokens, s.reasoning_source,
           s.estimated_cost_usd, s.is_archived, s.source_path,
           s.turn_count, s.error_count, s.interruption_count, s.compaction_count,
           s.sidechain_message_count, s.agent_spawn_count, s.skill_count, s.command_count,
           s.thinking_block_count, s.thinking_chars, s.active_seconds, s.outcome, s.work_type
    FROM session s LEFT JOIN project p ON p.id = s.project_id
    ORDER BY s.tool, s.source_session_id`,
  messages: `
    SELECT s.tool, s.source_session_id, m.seq, m.source_uuid, m.parent_source_uuid,
           m.role, m.model, m.stop_reason, m.timestamp, m.input_tokens, m.output_tokens,
           m.cache_read_tokens, m.cache_creation_tokens, m.raw
    FROM message m JOIN session s ON s.id = m.session_id
    ORDER BY s.tool, s.source_session_id, m.seq`,
  blocks: `
    SELECT s.tool, s.source_session_id, m.seq, b.ordinal, b.type, b.text,
           b.tool_name, b.tool_use_id, b.tool_input, b.tool_result
    FROM block b JOIN message m ON m.id = b.message_id JOIN session s ON s.id = b.session_id
    ORDER BY s.tool, s.source_session_id, m.seq, b.ordinal`,
  tool_calls: `
    SELECT s.tool, s.source_session_id, m.seq, tc.ordinal, tc.tool_kind, tc.tool_name,
           tc.mcp_server, tc.tool_base_name, tc.tool_use_id, tc.input, tc.is_error,
           tc.input_bytes, tc.has_result, tc.output_preview, tc.output_bytes,
           tc.duration_ms, tc.timestamp
    FROM tool_call tc
    LEFT JOIN message m ON m.id = tc.message_id
    JOIN session s ON s.id = tc.session_id
    ORDER BY s.tool, s.source_session_id, m.seq, tc.ordinal, tc.tool_use_id`,
  file_refs: `
    SELECT s.tool, s.source_session_id, m.seq, f.path, f.rel_path, f.ext,
           f.operation, f.timestamp
    FROM file_ref f
    LEFT JOIN message m ON m.id = f.message_id
    JOIN session s ON s.id = f.session_id
    ORDER BY s.tool, s.source_session_id, m.seq, f.path, f.operation`,
  recommendations: `
    SELECT key, kind, category, title, detail, suggestion, prompt, url,
           link_label, icon, tone, impact_label, score, status, status_source, note
    FROM recommendation
    ORDER BY key`,
} as const;
