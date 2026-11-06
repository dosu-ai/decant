# ATIF fixtures

Hand-written ATIF trajectories with invented content. None is derived from a
real run.

- `jobs/synthetic-job/trial-1/agent/trajectory.json` follows the layout and
  conventions of a Harbor Terminus 2 trial: per-step metrics with cache reads
  inside `prompt_tokens`, a result with no `source_call_id`, and a
  summarization subagent referenced by `trajectory_path`.
- `jobs/synthetic-job/trial-1/agent/trajectory.summarization-1-summary.json`
  is that subagent. Its first two steps are marked `is_copied_context`, and
  its model has no Decant rate, so the step's `cost_usd` stands.
- `embedded.atif.json` is an ATIF-v1.7 document in the shape `decant export
  --as atif` writes: Claude Code tool names, cache writes in
  `metrics.extra.cache_write_tokens`, a compaction boundary, a message written
  as content parts, and one subagent embedded in `subagent_trajectories` and
  linked from the spawning call.
