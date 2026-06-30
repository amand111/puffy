import { redactSecrets } from "./utils.js";

export function parseBody(text) {
  const source = String(text || "").trim();
  if (!source || /^(?:No |Request body is|Response body is)/.test(source)) return { kind: "empty", source, value: null, formatted: source };
  try {
    const value = JSON.parse(source);
    return { kind: "json", source, value, formatted: JSON.stringify(value, null, 2) };
  } catch {}
  if (/^(?:query|mutation|subscription|fragment)\b|^[\s\S]*\{[\s\S]*\}$/i.test(source) && /\b(?:query|mutation|subscription|fragment)\b|__typename/.test(source)) {
    return { kind: "graphql", source, value: source, formatted: formatGraphql(source) };
  }
  if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)+$/.test(source)) {
    const value = Object.fromEntries(new URLSearchParams(source));
    return { kind: "form", source, value, formatted: JSON.stringify(value, null, 2) };
  }
  return { kind: "text", source, value: source, formatted: source };
}

export function buildCurlCommand(request, bodyText = "") {
  const method = String(request?.method || "GET").toUpperCase();
  const lines = [`curl ${shellQuote(request?.url || "")}`];
  if (method !== "GET") lines.push(`  -X ${method}`);
  for (const header of request?.requestHeaders || []) {
    const name = String(header.name || "");
    if (!name || /^(?:content-length|host|cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i.test(name)) continue;
    lines.push(`  -H ${shellQuote(`${name}: ${redactSecrets(header.value || "", 1000)}`)}`);
  }
  const parsed = parseBody(bodyText);
  if (parsed.kind !== "empty" && parsed.source) lines.push(`  --data-raw ${shellQuote(redactSecrets(parsed.source, 12000))}`);
  return lines.map((line, index) => index ? `\\\n${line}` : line).join("");
}

export function buildGraphqlView(request, requestBody = "", responseBody = "") {
  const requestParsed = parseBody(requestBody);
  const requestJson = requestParsed.kind === "json" && requestParsed.value && typeof requestParsed.value === "object" ? requestParsed.value : null;
  const query = String(requestJson?.query || (requestParsed.kind === "graphql" ? requestParsed.source : ""));
  const variables = requestJson?.variables && typeof requestJson.variables === "object" ? requestJson.variables : null;
  const response = parseBody(responseBody);
  const responseJson = response.kind === "json" ? response.value : null;
  const errors = Array.isArray(responseJson?.errors) ? responseJson.errors.map((error) => ({ message: String(error?.message || "GraphQL error"), path: Array.isArray(error?.path) ? error.path.map(String) : [] })) : [];
  return {
    operation: request?.graphql || inferGraphqlOperation(query, requestJson?.operationName),
    query: query ? formatGraphql(query) : "",
    variables,
    response: responseJson,
    errors,
    data: responseJson && typeof responseJson === "object" ? responseJson.data ?? null : null
  };
}

export function formatGraphql(query) {
  const tokens = String(query || "").replace(/#[^\n]*/g, "").match(/\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|\$[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{|},]|"(?:\\.|[^"\\])*"/g) || [];
  let indent = 0;
  let line = "";
  const lines = [];
  const flush = () => { if (line.trim()) lines.push(`${"  ".repeat(indent)}${line.trim()}`); line = ""; };
  for (const token of tokens) {
    if (token === "{") { if (line.trim()) line += " {"; else line = "{"; flush(); indent += 1; }
    else if (token === "}") { flush(); indent = Math.max(0, indent - 1); lines.push(`${"  ".repeat(indent)}}`); }
    else if (token === ",") { line += ", "; }
    else if (token === "(") line += "(";
    else if (token === ")" || token === "]" || token === "!" || token === ":") line = `${line.trimEnd()}${token}${token === ":" ? " " : ""}`;
    else if (token === "[") line += "[";
    else if (token === "...") line += `${line ? " " : ""}...`;
    else line += `${line && !/[(:@[\s]$/.test(line) ? " " : ""}${token}`;
  }
  flush();
  return lines.join("\n");
}

export function jsonSummary(value) {
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === "object") return `${Object.keys(value).length} fields`;
  if (value === null) return "null";
  return typeof value;
}

function inferGraphqlOperation(query, operationName = "") {
  const match = String(query || "").match(/\b(query|mutation|subscription)\s*([_A-Za-z][_0-9A-Za-z]*)?/);
  return { kind: match?.[1] || "query", name: operationName || match?.[2] || "Anonymous" };
}

function shellQuote(value) {
  return `'${String(value || "").replaceAll("'", `'"'"'`)}'`;
}
