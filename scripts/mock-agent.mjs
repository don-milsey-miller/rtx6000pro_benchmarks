import { cp } from "node:fs/promises";
import { resolve } from "node:path";

const reference = process.env.MOCK_REFERENCE;
if (!reference) throw new Error("MOCK_REFERENCE is required");
await cp(reference, process.cwd(), { recursive: true, force: true });
const timestamp = Date.now();
const usage = { input: 1200, output: 300, reasoning: 50, cacheRead: 400, cacheWrite: 0, totalTokens: 1950, cost: { total: 0 } };
const events = [
  { type: "session", version: 3, id: process.env.MOCK_RUN_ID ?? "mock", timestamp: new Date().toISOString(), cwd: process.cwd() },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "src/server.mjs" } }], usage, stopReason: "toolUse", timestamp, durationMs: 100 } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Implemented and verified the product." }], usage, stopReason: "stop", timestamp: timestamp + 200, durationMs: 200 } },
  { type: "turn_end" },
  { type: "agent_settled", aborted: false },
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);

