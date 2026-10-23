export function parseJsonLines(text) {
  const events = [];
  const errors = [];
  for (const [index, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try { events.push(JSON.parse(line)); }
    catch (error) { errors.push({ line: index + 1, error: error.message }); }
  }
  return { events, errors };
}

function usageOf(event) {
  return event?.message?.usage ?? event?.usage ?? {};
}

function addUsage(total, usage) {
  total.input += Number(usage.input ?? usage.input_tokens ?? 0);
  total.output += Number(usage.output ?? usage.output_tokens ?? 0);
  total.reasoning += Number(usage.reasoning ?? usage.reasoning_tokens ?? 0);
  total.cacheRead += Number(usage.cacheRead ?? usage.cache_read_tokens ?? 0);
  total.cacheWrite += Number(usage.cacheWrite ?? usage.cache_write_tokens ?? 0);
}

function assistantMessage(event) {
  return event?.type === "message_end" && event?.message?.role === "assistant";
}

export function summarizePiEvents(text, sessionText = "") {
  const parsed = parseJsonLines(text);
  const session = parseJsonLines(sessionText);
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const eventCounts = {};
  const tools = {};
  const toolErrors = {};
  const toolDurationsMs = {};
  const accessedPaths = new Map();
  const repeatedCommands = new Map();
  let turns = 0;
  let modelRequests = 0;
  let peakContextTokens = 0;
  let modelDurationMs = 0;
  let finalResponse = "";
  let settled = false;

  for (const event of parsed.events) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === "turn_end") turns += 1;
    if (event.type === "agent_settled") settled = !event.aborted;
    if (!assistantMessage(event)) continue;
    modelRequests += 1;
    const currentUsage = usageOf(event);
    addUsage(usage, currentUsage);
    peakContextTokens = Math.max(peakContextTokens, Number(currentUsage.input ?? 0) + Number(currentUsage.cacheRead ?? 0));
    modelDurationMs += Number(event.message.durationMs ?? 0);
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    for (const item of content) {
      if (item?.type === "toolCall") {
        tools[item.name] = (tools[item.name] ?? 0) + 1;
        const path = item.arguments?.path;
        if (path) accessedPaths.set(path, (accessedPaths.get(path) ?? 0) + 1);
        const command = item.arguments?.command;
        if (command) repeatedCommands.set(command, (repeatedCommands.get(command) ?? 0) + 1);
      }
      if (item?.type === "text") finalResponse = item.text ?? finalResponse;
    }
  }

  for (const event of parsed.events) {
    if (!/tool.*(end|result)/i.test(event.type ?? "")) continue;
    const name = event.toolName ?? event.name ?? event.toolResult?.toolName ?? "unknown";
    if (event.isError || event.error || event.toolResult?.isError) toolErrors[name] = (toolErrors[name] ?? 0) + 1;
    const duration = Number(event.durationMs ?? event.toolResult?.durationMs ?? 0);
    if (duration > 0) (toolDurationsMs[name] ??= []).push(duration);
  }

  const sessionCompactions = session.events.filter((event) => (event?.entry ?? event)?.type === "compaction");
  const streamCompactions = parsed.events.filter((event) =>
    event?.type === "compaction" || event?.type === "compaction_end");
  const compactions = [];
  // A saved session has one durable entry per completed compaction. Prefer it
  // over stdout lifecycle events, where start/end describe the same operation.
  for (const event of sessionCompactions.length ? sessionCompactions : streamCompactions) {
    const entry = event?.entry ?? event;
    compactions.push({
      type: entry.type ?? event.type,
      tokensBefore: Number(entry.tokensBefore ?? event.tokensBefore ?? 0),
      firstKeptEntryId: entry.firstKeptEntryId ?? null,
    });
  }
  const uniqueCompactions = compactions.filter((item, index, all) =>
    index === all.findIndex((other) => other.type === item.type && other.tokensBefore === item.tokensBefore && other.firstKeptEntryId === item.firstKeptEntryId));
  const totalToolCalls = Object.values(tools).reduce((sum, value) => sum + value, 0);
  const totalToolErrors = Object.values(toolErrors).reduce((sum, value) => sum + value, 0);
  return {
    protocolValid: parsed.errors.length === 0 && parsed.events.length > 0,
    parseErrors: parsed.errors,
    sessionParseErrors: session.errors,
    eventCounts,
    turns,
    modelRequests,
    usage: { ...usage, total: usage.input + usage.output + usage.reasoning },
    peakContextTokens,
    modelDurationMs,
    tools,
    totalToolCalls,
    toolErrors,
    toolDurationsMs: Object.fromEntries(Object.entries(toolDurationsMs).map(([name, values]) => [name, {
      count: values.length,
      total: values.reduce((sum, value) => sum + value, 0),
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      max: Math.max(...values),
    }])),
    totalToolErrors,
    toolErrorRate: totalToolCalls ? totalToolErrors / totalToolCalls : 0,
    repeatedPaths: [...accessedPaths.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]),
    repeatedCommands: [...repeatedCommands.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]),
    compactions: uniqueCompactions,
    compactionCount: uniqueCompactions.length,
    settled,
    finalResponsePresent: Boolean(finalResponse.trim()),
    finalResponse,
  };
}

