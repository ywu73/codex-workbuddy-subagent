# Quick smoke test

Run this from any new Codex task after the Hook has been reviewed and trusted.
No repository checkout is required. The test makes one small WorkBuddy call.

```text
Test the installed WorkBuddy subagent through the installed Hook path.
Do not ask for credentials or display their values.

1. Load $use-workbuddy-worker. In parent-owned execution state, generate a
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

2. Stage that assignment through the installed plaintext handoff script:
   python3 "<codex-home>/hooks/codex-workbuddy-subagent/plaintext_handoff.py" --mode stage

3. Spawn the exact agent type workbuddy_worker with a unique task name and
   fork_turns="none".

4. Use one native task-sized idle wait or callback.

5. Pass only if a distinct workbuddy_worker child returns the exact fresh
   marker once, the child response shows a successful workbuddy_plan
   invocation, the pending handoff is consumed, and the parent model/provider
   configuration remains unchanged.

Do not use inherited-context fallback, direct WorkBuddy CLI invocations, or
another provider. If any boundary fails, report the exact failing boundary and
stop.
```
