# WorkBuddy Bridge Protocol v1

## Contents

- TaskSpec v1
- ResultEnvelope v1
- Background states and events
- Approval contract
- Batch contract
- Stable limits and failures

## TaskSpec v1

Use `task_spec` for nontrivial delegation. Legacy `prompt`, `task_label`, and `scope` remain compatible. When both forms are present, objective, label, and constraints must match exactly.

```json
{
  "version": "1",
  "objective": "Update the bounded parser implementation",
  "task_label": "parser",
  "parent_task_id": "optional-parent",
  "acceptance_criteria": ["Relevant tests pass"],
  "expected_artifacts": ["src/parser.ts"],
  "constraints": {
    "allowed_paths": ["src/**", "tests/**"],
    "max_changed_files": 8,
    "max_changed_bytes": 100000,
    "require_git_worktree": true
  }
}
```

Artifact paths and scope patterns must be relative and must not contain `..`. Scope supports `*`, `**`, and `?`. `.git` is never writable.

## ResultEnvelope v1

Completed foreground and background invocations preserve the original 0.5 fields and add:

```json
{
  "protocol_version": "1.0",
  "task_spec_version": "1",
  "envelope": {
    "invocation_id": "wb_...",
    "task_id": "wbt_... or null",
    "parent_task_id": "caller parent or null",
    "approval_id": "wba_... or null",
    "acceptance": [
      {
        "criterion": "Relevant tests pass",
        "status": "not_evaluated",
        "reason": "requires_caller_verification"
      }
    ],
    "artifacts": [{ "path": "src/parser.ts", "exists": true }]
  }
}
```

Failures also return `protocol_version` and `task_spec_version`. Never convert `not_evaluated` into success without independent evidence.

## Background states and events

States are `pending`, `running`, `completed`, `failed`, `cancelled`, `blocked`, and `orphaned`. Only `completed` is success.

Task metadata and events persist through macOS `/usr/bin/sqlite3` at `~/.codex/workbuddy-bridge/tasks.sqlite3` by default. Set `WORKBUDDY_TASK_DB_PATH` only to an exact trusted local path. Pending prompts remain process-local. A server restart discards them, marks prior `pending` or `running` tasks `orphaned`, and never resumes or retries them.

Pass the last `next_event_id` as `after_event_id` to receive only later events. Events are metadata-only.

## Approval contract

`workbuddy_execute_prepare` returns a token bound to:

- exact normalized task and TaskSpec;
- exact real `cwd` and worktree lock identity;
- exact execution scope;
- bounded workspace snapshot digest;
- expiry and unique approval ID.

Tokens are HMAC-signed, short-lived, single-use, and replay-protected in SQLite. The signing key defaults to `~/.codex/workbuddy-bridge/approval.key` with mode `0600`. The target baseline is checked during preparation, queue submission, and immediately before execution.

Never store approval tokens in audit output or task results. Prepare a new token after any bound value changes.

## Batch contract

Submit 1-16 tasks. Each task requires:

- unique `task_key`;
- `operation` of `plan` or `execute`;
- normal invocation fields or TaskSpec v1;
- zero or more `depends_on` task keys;
- a matching approval token for every execute task.

Dependencies must exist within the batch and be acyclic. A task becomes `blocked` when a dependency ends unsuccessfully. The bridge enforces its global concurrency budget and rejects unsafe worktree overlap before launch. It does not manage Git branches or worktrees.

## Stable limits and failures

Default global concurrency is 4. The persistent registry keeps at most 64 records for one hour after completion. Default execution limits are 100 changed files and 10 MiB, with bounded snapshot coverage.

Do not automatically retry writes after `APPROVAL_INVALID`, `APPROVAL_EXPIRED`, `APPROVAL_STALE`, `APPROVAL_REPLAYED`, `BATCH_CONFLICT`, `DEPENDENCY_FAILED`, `TASK_ORPHANED`, `SCOPE_VIOLATION`, timeout, cancellation, or uncertain side effects.
