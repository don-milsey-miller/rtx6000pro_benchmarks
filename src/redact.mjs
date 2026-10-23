const REDACTIONS = [
  [/\b(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, "$1[REDACTED]"],
  [/\b((?:api[_-]?key|access[_-]?token|tenant[_-]?token|secret)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
];

export function redactText(value, maxLength = 8_000) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[TRUNCATED]` : text;
}

export function redactValue(value, maxStringLength = 8_000, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value, maxStringLength);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, maxStringLength, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /(?:api[_-]?key|authorization|secret|tenant[_-]?token|access[_-]?token)/i.test(key)
      ? "[REDACTED]"
      : redactValue(item, maxStringLength, seen);
  }
  return output;
}
