/**
 * Local Claude slash commands such as /model and /exit can create transcript
 * files that contain only generated wrappers and command output. Keep those
 * records in the archive, but do not count or present them as agent sessions.
 *
 * A later human prompt or any assistant reply makes the session visible, so
 * legitimate unanswered and zero-cost conversations are preserved.
 *
 * Codex creates a thread and writes its rollout's session_meta before the
 * first prompt, so a new or duplicated chat that is never used leaves a rollout
 * with no turns. Codex hides those threads itself; so does Decant until the
 * rollout gains a message.
 */
export function visibleSessionPredicate(alias: string): string {
  return `NOT (
    CASE
      WHEN ${alias}.tool = 'claude_code'
        AND COALESCE(${alias}.title, '') LIKE '<local-command-caveat>%'
        AND ${alias}.model IS NULL
        AND ${alias}.total_input_tokens = 0
        AND ${alias}.total_output_tokens = 0
        AND ${alias}.estimated_cost_usd = 0
      THEN
        NOT EXISTS (
          SELECT 1
          FROM message visibility_assistant
          WHERE visibility_assistant.session_id = ${alias}.id
            AND visibility_assistant.role = 'assistant'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM message visibility_user
          JOIN block visibility_block ON visibility_block.message_id = visibility_user.id
          WHERE visibility_user.session_id = ${alias}.id
            AND visibility_user.role = 'user'
            AND visibility_block.type = 'text'
            AND visibility_block.text IS NOT NULL
            AND TRIM(visibility_block.text) != ''
            AND NOT (
              LTRIM(visibility_block.text) LIKE '<local-command-caveat>%'
              OR LTRIM(visibility_block.text) LIKE '<local-command-stdout>%'
              OR LTRIM(visibility_block.text) LIKE '<local-command-stderr>%'
              OR LTRIM(visibility_block.text) LIKE '<local-command-output>%'
              OR LTRIM(visibility_block.text) LIKE '<command-name>%'
            )
        )
      WHEN ${alias}.tool = 'codex'
        AND ${alias}.model IS NULL
        AND ${alias}.message_count = 0
        AND ${alias}.total_input_tokens = 0
        AND ${alias}.total_output_tokens = 0
      THEN
        NOT EXISTS (
          SELECT 1 FROM message visibility_any WHERE visibility_any.session_id = ${alias}.id
        )
      ELSE 0
    END
  )`;
}
