export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function getHeader(headers, name) {
  const lower = name.toLowerCase();
  return (headers || []).find((header) => String(header.name).toLowerCase() === lower)?.value || "";
}

export function sanitizeHeaders(headers = []) {
  const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;
  return headers.map((header) => ({
    name: String(header.name || ""),
    value: sensitive.test(header.name || "") ? "[redacted]" : String(header.value || "")
  }));
}

export function redactSecrets(value, limit = 12000) {
  return String(value || "")
    .replace(/(["']?(?:token|access_token|refresh_token|api_key|apikey|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi, "$1[redacted]")
    .slice(0, limit);
}

export function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

export function getPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url || "unknown";
  }
}

export function getPathname(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url || "unknown";
  }
}

export function getSiteKey(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  if (!host || host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  const secondLevel = new Set(["co.uk", "org.uk", "com.au", "net.au", "co.jp", "co.in", "com.br", "com.mx"]);
  return secondLevel.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

export function isSameSite(firstDomain, secondDomain) {
  const first = getSiteKey(firstDomain);
  const second = getSiteKey(secondDomain);
  return Boolean(first && second && first === second);
}

export function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function stableRequestKey(entry) {
  const request = entry.request || entry;
  const started = entry.startedDateTime || entry.startedAt || "";
  return `${request.method || "GET"}|${request.url || ""}|${started}`;
}

export function normalizeEndpoint(url) {
  try {
    const parsed = new URL(url);
    const normalized = parsed.pathname.split("/").map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":uuid";
      if (/^[0-9a-f]{20,}$/i.test(segment)) return ":hash";
      if (/^[A-Za-z0-9_-]{28,}$/.test(segment)) return ":token";
      return segment;
    }).join("/");
    return normalized || "/";
  } catch {
    return String(url || "unknown").split("?")[0];
  }
}

export function parseGraphqlOperation(url, postText = "") {
  if (!/graphql/i.test(url || "") && !/operationName|\b(query|mutation|subscription)\b/.test(postText || "")) return null;
  try {
    const parsed = JSON.parse(postText);
    const query = String(parsed.query || "");
    const match = query.match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
    return {
      name: parsed.operationName || match?.[2] || "Anonymous operation",
      kind: match?.[1] || "operation"
    };
  } catch {
    const match = String(postText).match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
    return match ? { name: match[2], kind: match[1] } : { name: "Unknown operation", kind: "operation" };
  }
}

export function makeId(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
