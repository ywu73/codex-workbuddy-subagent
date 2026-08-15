#!/usr/bin/env node

import readline from "node:readline";

const mode = process.env.FAKE_ACP_MODE ?? "respond";
const sessionId = "fake-session";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } },
    });
    return;
  }
  if (request.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId, models: { currentModelId: "hy3" } },
    });
    return;
  }
  if (request.method === "session/prompt") {
    if (mode === "stall-prompt") {
      process.stderr.write("fake upstream waiting for model response\n");
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "READY" } } },
    });
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (request.method === "session/cancel") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "session_info_update" } } });
  }
});
