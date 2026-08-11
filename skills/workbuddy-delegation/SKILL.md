---
name: workbuddy-delegation
description: Safely delegate explicitly requested, bounded local analysis or scoped file editing to WorkBuddy or CodeBuddy through a versioned, persistent, auditable bridge. Use when the user names WorkBuddy or CodeBuddy, asks to delegate a clear local task, requests foreground or background planning, explicitly authorizes a scoped edit, wants several isolated WorkBuddy workers, or asks to check bridge/CLI health. Do not trigger merely because WorkBuddy could help, for unclear directories, account/payment/credential/privacy settings, permission bypass, broad filesystem access, or WorkBuddy GUI state.
---

# WorkBuddy Delegation

Use the bridge as a bounded worker interface. Keep Codex responsible for decomposition, user confirmation, worktree lifecycle, independent verification, and final synthesis.

Expected bridge version: `1.0.1`

Read [references/protocol-v1.md](references/protocol-v1.md) when constructing TaskSpec v1, interpreting ResultEnvelope v1, using approval tokens, or starting a batch.

## Establish the boundary

1. Tell the user when delegating a bounded task to the local WorkBuddy CLI.
2. Resolve the exact absolute task directory. Never use `/`, the home directory, a system directory, a guessed parent, a glob, or an environment placeholder.
3. Separate analysis from modification. Never turn plan intent into execute intent.
4. Use TaskSpec v1 for nontrivial work: state one objective, acceptance criteria, expected artifacts, and narrow constraints.
5. For writes, restrict relative paths, changed-file count, changed bytes, and require a Git worktree when repository isolation matters.
6. Never use the bridge for credentials, billing, privacy settings, GUI state, permission bypass, arbitrary flags, shell access, push, PR, release, or broad filesystem work.

The exact validated `cwd` is the authorization boundary when the client does not advertise workspace roots. Selecting it is a security decision.

## Route tools

- Call `workbuddy_health` for CLI readiness and plugin/Skill/server/protocol version consistency. Stop and restart the local Codex client when it reports a mismatch.
- Call `workbuddy_plan` for bounded foreground read-only analysis.
- Call `workbuddy_execute` only for an explicitly authorized foreground edit with confirmed scope.
- Call `workbuddy_plan_start` for persistent background read-only work.
- Call `workbuddy_execute_prepare`, then `workbuddy_execute_start`, for an explicitly authorized background edit.
- Call `workbuddy_batch_start` for 1-16 bounded tasks with explicit dependencies. Supply a separate approval token for every execute task.
- Call `workbuddy_task_status` with `after_event_id` to read incremental task events.
- Call `workbuddy_batch_status` to synthesize a batch.
- Call `workbuddy_task_cancel` once to cancel pending or running work, then check status.

Never replace a bridge failure with a direct WorkBuddy shell command or broader permissions.

## Approve background writes

1. Confirm that the user authorized the exact edit, directory, and scope.
2. Call `workbuddy_execute_prepare` to bind the task, worktree identity, scope, and workspace baseline.
3. Inspect the returned preview. Do not proceed if it differs from the authorized task.
4. Pass the unchanged task fields and single-use token to `workbuddy_execute_start` before expiry.
5. Prepare again after any task, scope, worktree, or workspace-baseline change.

Treat a token as a technical binding, not as a substitute for user authorization. Never reuse it. The bridge rechecks the baseline immediately before background execution and never automatically retries writes.

## Coordinate several workers

- Keep within `workbuddy_health.limits.max_concurrency`.
- Give every task a unique `task_key` and useful `task_label`.
- Express dependencies explicitly; do not infer completion from launch order.
- Allow concurrent plans. Never schedule overlapping writes in one worktree.
- Give independent code-writing tasks independent branches and Git worktrees under the repository's rules.
- Let the bridge reject unsafe same-worktree batches; never bypass `BATCH_CONFLICT`, `DIRECTORY_LOCKED`, or `BRIDGE_BUSY`.
- Treat `blocked`, `cancelled`, `failed`, and `orphaned` as terminal non-success states.
- After restart, inspect orphaned tasks and filesystem evidence. Never automatically rerun an interrupted write.

The bridge verifies worktree identity and locking but never creates, removes, commits, merges, pushes, or publishes Git state.

## Verify results

- Attribute delegated content to WorkBuddy and distinguish it from Codex's judgment.
- Preserve `task_id`, `invocation_id`, `approval_id`, `parent_task_id`, labels, and event cursors.
- Treat acceptance entries marked `not_evaluated` as caller work, not passed checks.
- Inspect expected artifacts and actual files independently.
- Compare change evidence with the authorized scope and run relevant tests or checks yourself.
- If side effects may have occurred, inspect the workspace before any further action.
- Report unperformed browser, remote, release, push, PR, or real-world validation.

The audit log is metadata-only. Never add prompts, source content, WorkBuddy output, credentials, or secrets to it.
