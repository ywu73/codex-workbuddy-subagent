<!-- codex-workbuddy-subagent:start -->
- Modes:
  - `plan`: local analysis, requirement extraction, repository mapping, log classification, and test or option preparation.
  - `execute`: only explicitly authorized local edits bounded by directory, paths, file count, and byte count.
- Boundary: preliminary input only; the parent verifies, decides, and validates actual changes.
- Workflow: load `$use-workbuddy-worker`; resolve one of the four model profiles, stage one JSON assignment with the returned `agent_type`, and spawn that exact type with `fork_turns="none"`. No shell, direct-API, or inherited-context bypass.
<!-- codex-workbuddy-subagent:end -->
