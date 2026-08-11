const secretPatterns: Array<[RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi, "$1[REDACTED]"],
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]"],
  [/\b(gh[opusr]_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]"],
];

export function redactText(value: string, maxLength = 4096): string {
  let redacted = value;
  for (const [pattern, replacement] of secretPatterns) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (redacted.length > maxLength) return `${redacted.slice(0, maxLength)}…[TRUNCATED]`;
  return redacted;
}

export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactUnknown(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
    return Object.fromEntries(entries.map(([key, item]) => [key, redactUnknown(item, depth + 1)]));
  }
  return value;
}
