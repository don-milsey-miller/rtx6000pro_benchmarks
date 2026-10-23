import assert from "node:assert/strict";
import test from "node:test";
import bashTimeout from "../runpod/extensions/bash-timeout.mjs";

test("adds a bounded default without overriding an explicit bash timeout", async () => {
  let handler;
  bashTimeout({ on(name, callback) { if (name === "tool_call") handler = callback; } });
  const defaulted = { toolName: "bash", input: { command: "npm test" } };
  const explicit = { toolName: "bash", input: { command: "sleep 1", timeout: 5 } };
  await handler(defaulted);
  await handler(explicit);
  assert.equal(defaulted.input.timeout, 120);
  assert.equal(explicit.input.timeout, 5);
});
