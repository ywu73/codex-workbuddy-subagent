# Quick smoke test

Run this from any new Codex task after the Hook has been reviewed and trusted.
The Hook will start the native adapter on demand if it is not already listening
on `127.0.0.1:17891`. No repository checkout is required. The test makes one
small WorkBuddy call.

```text
Test the installed native WorkBuddy subagent through the installed Hook path.
Do not ask for credentials or display their values.

1. Optionally verify `GET http://127.0.0.1:17891/healthz` reports `status=ready`.

2. Load $use-workbuddy-worker. In parent-owned execution state, generate a
   fresh unpredictable marker and build one child assignment as a JSON object:
   {
     "operation": "plan",
     "cwd": "<an existing absolute local directory inside allowed roots>",
     "task_spec": {
       "objective": "Read one visible README file and return its first heading
                      as a single sentence.",
       "task_label": "quick-smoke",
       "acceptance_criteria": ["The output contains a heading."],
       "constraints": {}
     },
     "max_turns": 3,
     "timeout_seconds": 120,
     "marker": "<the fresh marker>"
   }

3. Stage that assignment through the installed plaintext handoff script:
   python3 "<codex-home>/hooks/codex-workbuddy-subagent/plaintext_handoff.py" --mode stage

4. Resolve and spawn the exact agent type returned by the resolver (use
   `workbuddy_worker` / `hy3` for this text smoke) with a unique task name and
   fork_turns="none". The staged `--agent-type` and spawned agent type must
   match exactly.

5. Use one native task-sized idle wait or callback.

6. Pass only if a distinct selected WorkBuddy child returns the exact fresh
   marker once, the child is served by the local WorkBuddy provider, the
   pending handoff is consumed, and the parent model/provider configuration
   remains unchanged.

Do not use inherited-context fallback, `workbuddy_plan`, direct WorkBuddy CLI
invocations, OpenCode, CC Switch, or another provider. If any boundary fails,
report the exact failing boundary and stop.
```
