#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = process.env.WORKBUDDY_WORKER_ROUTING_CONFIG
  ? path.resolve(process.env.WORKBUDDY_WORKER_ROUTING_CONFIG)
  : [
      path.resolve(scriptDirectory, "workbuddy-worker-routing.json"),
      path.resolve(scriptDirectory, "../config/workbuddy-worker-routing.json"),
    ].find((candidate) => existsSync(candidate)) ?? path.resolve(scriptDirectory, "../config/workbuddy-worker-routing.json");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function resolveProfileName(config, value) {
  if (typeof value !== "string" || !value.trim()) fail("A worker selector must be a non-empty string.");
  if (Object.hasOwn(config.workers, value)) return value;
  const alias = config.aliases?.[value];
  if (alias && Object.hasOwn(config.workers, alias)) return alias;
  const matchingProfile = Object.entries(config.workers).find(([, worker]) => worker.agent_type === value);
  if (matchingProfile) return matchingProfile[0];
  fail(`Unknown WorkBuddy worker profile, alias, or agent type: ${value}`);
}

function assertWorkerProfile(profileName, worker) {
  if (!isObject(worker)) fail(`Worker profile ${profileName} must be an object.`);
  for (const field of ["agent_type", "model", "model_provider", "base_url", "wire_api", "cost_class", "status"]) {
    if (typeof worker[field] !== "string" || !worker[field]) fail(`Worker profile ${profileName} has an invalid ${field}.`);
  }
  if (!Number.isSafeInteger(worker.model_context_window) || worker.model_context_window <= 0) {
    fail(`Worker profile ${profileName} has an invalid model_context_window.`);
  }
  if (worker.wire_api !== "responses") fail(`Worker profile ${profileName} has unsupported wire API ${worker.wire_api}.`);
  for (const field of ["strengths", "avoid"]) {
    if (!Array.isArray(worker[field]) || worker[field].some((item) => typeof item !== "string" || !item)) {
      fail(`Worker profile ${profileName} has an invalid ${field} list.`);
    }
  }
  if (!isObject(worker.validation)) fail(`Worker profile ${profileName} must declare validation status.`);
}

export function validateRoutingConfig(config) {
  if (!isObject(config) || config.version !== 1) fail("Routing config must be an object with version 1.");
  if (!isObject(config.workers) || Object.keys(config.workers).length === 0) fail("Routing config must define at least one worker profile.");
  if (!isObject(config.aliases) || !isObject(config.task_profiles)) fail("Routing config must define aliases and task_profiles objects.");
  if (typeof config.default_profile !== "string") fail("Routing config must define default_profile.");

  const agentTypes = new Set();
  const models = new Set();
  for (const [profileName, worker] of Object.entries(config.workers)) {
    assertWorkerProfile(profileName, worker);
    if (agentTypes.has(worker.agent_type)) fail(`Agent type is duplicated: ${worker.agent_type}`);
    if (models.has(worker.model)) fail(`Model is duplicated: ${worker.model}`);
    agentTypes.add(worker.agent_type);
    models.add(worker.model);
  }
  resolveProfileName(config, config.default_profile);
  for (const [alias, profile] of Object.entries(config.aliases)) {
    if (typeof alias !== "string" || !alias || typeof profile !== "string") fail("Routing config contains an invalid alias.");
    resolveProfileName(config, profile);
  }
  for (const [task, profile] of Object.entries(config.task_profiles)) {
    if (typeof task !== "string" || !task || typeof profile !== "string") fail("Routing config contains an invalid task profile.");
    resolveProfileName(config, profile);
  }
  return config;
}

export function loadRoutingConfig(configPath = defaultConfigPath) {
  const resolvedPath = path.resolve(configPath);
  try {
    return validateRoutingConfig(JSON.parse(readFileSync(resolvedPath, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Routing config")) throw error;
    if (error instanceof Error && (error.message.startsWith("Worker profile") || error.message.startsWith("Unknown"))) throw error;
    fail(`Unable to read routing config ${resolvedPath}: ${error.message}`);
  }
}

function findProfileBy(config, field, value) {
  const match = Object.entries(config.workers).find(([, worker]) => worker[field] === value);
  if (!match) fail(`No WorkBuddy worker profile matches ${field}=${value}.`);
  return match[0];
}

export function resolveSelection(config, request = {}) {
  validateRoutingConfig(config);
  const selectors = ["profile", "worker", "agent_type", "model", "task"].filter((field) => request[field] !== undefined);
  if (selectors.length > 1) fail(`Choose only one selector; received: ${selectors.join(", ")}.`);

  let profile;
  let source;
  let input;
  const selector = selectors[0];
  if (selector === "profile" || selector === "worker") {
    profile = resolveProfileName(config, request[selector]);
    source = "explicit_profile";
    input = request[selector];
  } else if (selector === "agent_type") {
    profile = findProfileBy(config, "agent_type", request.agent_type);
    source = "explicit_agent_type";
    input = request.agent_type;
  } else if (selector === "model") {
    profile = findProfileBy(config, "model", request.model);
    source = "explicit_model";
    input = request.model;
  } else if (selector === "task") {
    const taskProfile = config.task_profiles[request.task];
    if (!taskProfile) fail(`Unknown task profile: ${request.task}`);
    profile = resolveProfileName(config, taskProfile);
    source = "task_profile";
    input = request.task;
  } else {
    profile = resolveProfileName(config, config.default_profile);
    source = "default_profile";
    input = config.default_profile;
  }

  const worker = config.workers[profile];
  if (worker.status !== "available") fail(`Worker profile ${profile} is unavailable (status=${worker.status}); refusing silent fallback.`);
  return { selected_profile: profile, ...worker, selection_source: source, selection_input: input };
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/resolve-worker.mjs [selector]",
    "",
    "Selectors (choose at most one):",
    "  --profile <name-or-alias>",
    "  --worker <profile-or-agent-type>",
    "  --agent-type <agent-type>",
    "  --model <model-id>",
    "  --task <task-profile>",
    "  --config <path>",
    "",
    "The command prints the resolved profile as JSON. Stage and spawn the returned",
    "agent_type exactly; do not silently fall back to another WorkBuddy model.",
  ].join("\n") + "\n");
}

function parseArguments(argv) {
  const request = {};
  let configPath = defaultConfigPath;
  const options = new Map([["--profile", "profile"], ["--worker", "worker"], ["--agent-type", "agent_type"], ["--model", "model"], ["--task", "task"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { printHelp(); process.exit(0); }
    if (argument === "--config") {
      configPath = argv[++index];
      if (!configPath) fail("--config requires a path.");
      continue;
    }
    const field = options.get(argument);
    if (!field) fail(`Unknown option: ${argument}`);
    const value = argv[++index];
    if (!value) fail(`${argument} requires a value.`);
    request[field] = value;
  }
  return { configPath, request };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { configPath, request } = parseArguments(argv);
    process.stdout.write(`${JSON.stringify(resolveSelection(loadRoutingConfig(configPath), request), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`WorkBuddy worker selection failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  (
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  )
) main();
