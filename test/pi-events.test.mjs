import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonLines, summarizePiEvents } from "../src/pi-events.mjs";

const lines = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "SPEC.md" } }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }], usage: { input: 1000, output: 50, reasoning: 20, cacheRead: 200 }, durationMs: 500 } },
  { type: "tool_execution_end", toolName: "bash", isError: true },
  { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "SPEC.md" } }], usage: { input: 1200, output: 30, cacheRead: 500 }, durationMs: 600 } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input: 900, output: 10 }, durationMs: 200 } },
  { type: "turn_end" },
  { type: "agent_settled", aborted: false },
].map(JSON.stringify).join("\n");

test("parses and summarizes Pi stream without double counting", () => {
  const summary = summarizePiEvents(lines, JSON.stringify({ type: "compaction", tokensBefore: 60000, firstKeptEntryId: "x" }));
  assert.equal(summary.protocolValid, true);
  assert.equal(summary.modelRequests, 3);
  assert.equal(summary.usage.input, 3100);
  assert.equal(summary.usage.cacheRead, 700);
  assert.equal(summary.totalToolCalls, 3);
  assert.equal(summary.tools.read, 2);
  assert.equal(summary.totalToolErrors, 1);
  assert.equal(summary.compactionCount, 1);
  assert.equal(summary.finalResponse, "Done");
  assert.deepEqual(summary.repeatedPaths, [["SPEC.md", 2]]);
});

test("reports malformed lines", () => {
  const parsed = parseJsonLines('{}\n{"bad"');
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.errors.length, 1);
});

test("counts one durable compaction instead of stdout start and end events", () => {
  const stream = [
    { type: "agent_start" },
    { type: "compaction_start", tokensBefore: 60000 },
    { type: "compaction_end", tokensBefore: 60000 },
  ].map(JSON.stringify).join("\n");
  const session = JSON.stringify({ type: "compaction", tokensBefore: 60000, firstKeptEntryId: "kept" });
  const summary = summarizePiEvents(stream, session);
  assert.equal(summary.compactionCount, 1);
  assert.equal(summary.compactions[0].firstKeptEntryId, "kept");
});

