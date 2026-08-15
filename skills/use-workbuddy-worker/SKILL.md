---
name: use-workbuddy-worker
description: Use one of the native WorkBuddy-backed model-selectable workers through the installed one-shot plaintext SubagentStart Hook and local Responses-to-ACP provider adapter. Use whenever Codex considers spawning, continuing, or troubleshooting these workers; it governs model selection, plaintext staging of a single bounded assignment, native fork_turns=none spawning and return, one-shot state recovery, and WorkBuddy safety boundaries.
---

# Use WorkBuddy Worker

## Choose the worker

Available native worker profiles are:

- `workbuddy_worker` -> `hy3` (default text profile)
- `workbuddy_worker_glm52` -> `glm-5.2` (reasoning-heavy text profile)
- `workbuddy_worker_minimax_m3` -> `minimax-m3` (multimodal profile)
- `workbuddy_worker_kimi_k27` -> `kimi-k2.7` (multimodal profile)

Resolve a requested profile, agent type, model, or task alias with the installed
`resolve-worker.mjs` and use its `agent_type` and `model` exactly. If the
selector is absent, use the default `hy3` profile. If a selector is unknown or
unavailable, stop; never silently fall back to another model.

- Use the native WorkBuddy worker for bounded read‑only text, code, log,
  search, extraction, or high‑volume reading work. For explicitly authorized
  file edits, use the separate WorkBuddy Bridge execute path after the user
  has confirmed the exact task, directory, allowed path patterns, changed-file
  count, and changed-byte limit.
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

1. Build a complete read-only `plan` assignment containing:
   operation (`plan`),
   exact `cwd`, `task_spec` (with objective, acceptance criteria, expected
   artifacts, constraints), `max_turns`, `timeout_seconds`, a fresh random
   marker for end-to-end proof, and a request for compact structured output.
2. Resolve the worker before staging, for example:
   `node "<codex-home>/hooks/codex-workbuddy-subagent/resolve-worker.mjs" --model glm-5.2`
   Capture the returned `agent_type` and `model`; do not infer either from a
   display label.
3. Pipe the complete assignment as a single JSON object through stdin to the
   installed handoff script in `stage` mode, passing the resolved agent type:
   `python3 "<codex-home>/hooks/codex-workbuddy-subagent/plaintext_handoff.py" --mode stage --agent-type <agent_type>`
4. Require a successful stage result naming the same selected agent type. Treat a lock
   contender, an active pending or claimed item, quarantined state, or any
   other non‑success result as a transport failure. Never spawn after a
   failed stage.
5. Create the child with the exact resolved agent type, a unique task
   name, and `fork_turns="none"`. Do not replace this with a shell call,
   direct API, or inherited root history.
6. Wait through Codex's native callback. Do not short‑poll, duplicate the
   child's work, or invent another return transport while it runs.
7. Verify the returned marker and WorkBuddy result. Compare change evidence
   with the authorized scope. Run any independent checks the task
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
  absent callback, or native WorkBuddy adapter unavailability as a transport failure.
  Do not silently substitute another tool, CLI, direct API call, or inherited
  root history.
- Multi‑agent V1 is an explicit top‑level session compatibility choice, not a
  per‑spawn switch or silent fallback.
- The staged assignment briefly exists as plaintext in local user state before
  the child reads its developer context. The Hook is a transport compatibility
  layer, not a confidential channel.

## Native provider contract

The local WorkBuddy provider adapter enforces:

- Codex Responses requests translated into WorkBuddy ACP sessions;
- WorkBuddy started with the configured model, `plan` permission mode, and
  restricted `Read` tools for this worker;
- each request may select only `hy3`, `glm-5.2`, `minimax-m3`, or `kimi-k2.7`;
- `minimax-m3` and `kimi-k2.7` may receive image blocks only after the ACP
  session advertises image prompt capability; remote image URLs are rejected;
- ACP message chunks collected into a bounded Responses result;
- adapter timeouts, process exits, malformed JSON, and empty output treated as
  failures;
- localhost-only binding without credentials in the assignment or child prompt.

The WorkBuddy Bridge remains a separate parent-side MCP delegation path. The
native child must not call `workbuddy_plan`, launch another CLI, or bypass its
configured provider.
