import assert from "node:assert/strict";
import test from "node:test";

import { loadRoutingConfig, resolveSelection } from "../scripts/resolve-worker.mjs";

const config = loadRoutingConfig();

test("defaults to the model-labelled Hy3 worker", () => {
  const result = resolveSelection(config);

  assert.equal(result.selected_profile, "hy3");
  assert.equal(result.agent_type, "workbuddy_worker_hy3");
  assert.equal(result.display_name, "WorkBuddy Worker Hy3");
  assert.equal(result.model, "hy3");
});

test("resolves an exact model to its model-labelled worker", () => {
  const result = resolveSelection(config, { model: "kimi-k2.7" });

  assert.equal(result.selected_profile, "kimi_k27");
  assert.equal(result.agent_type, "workbuddy_worker_kimi_k27");
  assert.equal(result.display_name, "WorkBuddy Worker Kimi K2.7");
});

test("does not resolve the legacy generic agent type", () => {
  assert.throws(
    () => resolveSelection(config, { agent_type: "workbuddy_worker" }),
    /No WorkBuddy worker profile matches agent_type=workbuddy_worker\./,
  );
});
