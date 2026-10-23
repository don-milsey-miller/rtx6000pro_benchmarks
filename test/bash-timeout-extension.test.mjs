import assert from "node:assert/strict";
import test from "node:test";
import bashTimeout from "../runpod/extensions/bash-timeout.mjs";

test("adds a bounded default, preserves shorter limits, and caps excessive limits", async () => {
  let handler;
  bashTimeout({ on(name, callback) { if (name === "tool_call") handler = callback; } });
  const defaulted = { toolName: "bash", input: { command: "npm test" } };
  const shorter = { toolName: "bash", input: { command: "sleep 1", timeout: 5 } };
  const excessive = { toolName: "bash", input: { command: "npm test", timeout: 240 } };
  await handler(defaulted);
  await handler(shorter);
  await handler(excessive);
  assert.equal(defaulted.input.timeout, 120);
  assert.equal(shorter.input.timeout, 5);
  assert.equal(excessive.input.timeout, 120);
});
