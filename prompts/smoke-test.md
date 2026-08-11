# Native runtime smoke test

Run this from a new Codex task whose workspace is this repository, after the
custom agent and the one-shot `SubagentStart` Hook have been installed and
trusted. This test verifies Hook delivery, custom-agent discovery, native child
creation, WorkBuddy Bridge availability, a read-only plan, and the native
callback.

```text
Run the repository native WorkBuddy subagent smoke test.

1. As the root agent, generate a fresh unpredictable marker locally.

2. Build this complete child assignment in parent-owned local execution state:
   - operation: plan
   - cwd: <current repository checkout>
   - objective: "Read fixtures/smoke-input.txt and return the exact third
     non-empty line, the file SHA-256 digest, and the marker."
   - task_label: "smoke-plan"
   - max_turns: 3
   - timeout_seconds: 120
   - marker: <fresh marker>

3. Stage, spawn workbuddy_worker with unique name and fork_turns="none",
   wait through callback.

4. Pass only if the child returns the exact fresh marker once and a successful
   workbuddy_plan result containing the fixture answer.

Expected fixture result:
- Third non-empty line: responses
- SHA-256: 9713b1d1030d64088acd78fc899fa22a0f5f6c7f5cfd0887b531aadbae35c7df
- Files changed by the child: none

Report the final smoke summary and whether any file changed.
```
