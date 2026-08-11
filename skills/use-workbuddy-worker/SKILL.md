---
name: use-workbuddy-worker
description: Use the WorkBuddy-backed workbuddy_worker through the installed one-shot plaintext SubagentStart Hook. Use whenever Codex considers spawning, continuing, or troubleshooting this worker; it governs task suitability, plaintext staging of a single bounded assignment, native fork_turns=none spawning and return, one-shot state recovery, and WorkBuddy safety boundaries.
---

# Use WorkBuddy Worker

## Choose the worker

- Use the WorkBuddy worker for bounded, preferably read‑only text, code, log,
  search, extraction, or high‑volume reading work. For explicitly authorized,
  scoped file edits use the worker's execute path only after the user has
  confirmed the exact task, directory, allowed path patterns, changed-file
  count, and changed‑byte limit.
- Keep tightly coupled reasoning, consequential decisions, verification, and
  final integration in the parent.
- Do not send secrets, private source, personal data, or regulated material
  unless the user has accepted WorkBuddy as the processor for that data.
- Keep the parent and its provider independent from the child transport. Do not
  switch the parent provider or model to delegate.
- The WorkBuddy CLI provider is managed by the user's WorkBuddy installation.
  Never stage WorkBuddy authentication credentials in the assignment or the
  spawn message.

## Deliver one self-contained job

1. Build a complete assignment containing: operation (`plan` or `execute`),
   exact `cwd`, `task_spec` (with objective, acceptance criteria, expected
   artifacts, constraints), `max_turns`, `timeout_seconds`, a fresh random
   marker for end-to-end proof, a request for compact structured output, and,
   for execute, the confirmed scope. The assignment must also signal whether
   the user explicitly authorized the write.
2. Pipe the complete assignment as a single JSON object through stdin to the
   installed handoff script in `stage` mode:
   `python3 "<codex-home>/hooks/codex-workbuddy-subagent/plaintext_handoff.py" --mode stage`
3. Require a successful stage result naming `workbuddy_worker`. Treat a lock
   contender, an active pending or claimed item, quarantined state, or any
   other non‑success result as a transport failure. Never spawn after a
   failed stage.
4. Create the child with the exact agent type `workbuddy_worker`, a unique task
   name, and `fork_turns="none"`. Do not replace this with a shell call,
   direct API, or inherited root history.
5. Wait through Codex's native callback. Do not short‑poll, duplicate the
   child's work, or invent another return transport while it runs.
6. Verify the returned marker and the bridge's result envelope. Compare change
   evidence with the authorized scope. Run any independent checks the task
   contract requires. Keep acceptance-criteria evaluation until after you have
   inspected the actual workspace.

## Respect dispatch and delivery semantics

- Treat delivery as one‑shot and at‑most‑once. Never assume a claimed
  assignment can be replayed or delivered to a replacement child.
- After a worker has received its assignment, it no longer holds the dispatch
  lock; you may stage and spawn the next job before that worker returns.
  Already‑running workers continue concurrently.
- Require explicit resolution for malformed or quarantined state. Never delete,
  replace, or overwrite it automatically.

## Fail and continue safely

- Treat a missing Hook assignment, failed stage, unreadable child task,
  absent callback, or WorkBuddy Bridge unavailability as a transport failure.
  Do not silently substitute another tool, CLI, direct API call, or inherited
  root history.
- Multi‑agent V1 is an explicit top‑level session compatibility choice, not a
  per‑spawn switch or silent fallback.
- The staged assignment briefly exists as plaintext in local user state before
  the child reads its developer context. The Hook is a transport compatibility
  layer, not a confidential channel.

## Bridge safety contract

The WorkBuddy Bridge enforces:

- exact `cwd` validation against user‑configured allowed roots;
- TaskSpec v1 normalization (prompt, objective, label, scope must be consistent);
- before‑and‑after workspace snapshots with bounded scope checks;
- worktree‑aware locking that prevents overlapping writes;
- output‑size limits, redaction of credential‑like text, and JS‑based result parsing
  that never exposes raw invalid output;
- metadata‑only audit records (no task content, no WorkBuddy model output,
  no credentials);
- optional persistent background tasks, approval tokens, dependency‑aware
  batches, and event‑cursor task status.

Read [references/bridge-v1.md](references/bridge-v1.md) for the exact
TaskSpec/ResultEnvelope contract, background states, and approval semantics.
The bridge's 10‑tool surface is documented in its own README.
