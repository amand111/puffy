import { buildGraphqlView, jsonSummary, parseBody } from "../core/inspector.js";
import { escapeHtml } from "../core/utils.js";

export function bodyViewerHtml(text, { side, requestId, mode = "tree" } = {}) {
  const parsed = parseBody(text);
  const canTree = ["json", "form"].includes(parsed.kind);
  const effectiveMode = canTree ? mode : "raw";
  const content = effectiveMode === "tree" ? jsonTreeHtml(parsed.value, { rootLabel: side === "request" ? "request" : "response" }) : highlightedBodyHtml(parsed);
  return `<div class="body-viewer" data-body-viewer="${escapeHtml(side)}"><div class="body-toolbar"><div><span class="chip info">${escapeHtml(parsed.kind)}</span><span class="body-summary">${escapeHtml(jsonSummary(parsed.value))}</span></div><div class="body-actions">${canTree ? `<div class="segmented"><button type="button" data-body-mode="tree" data-body-side="${side}" data-body-request-id="${requestId}" class="${effectiveMode === "tree" ? "active" : ""}">Tree</button><button type="button" data-body-mode="raw" data-body-side="${side}" data-body-request-id="${requestId}" class="${effectiveMode === "raw" ? "active" : ""}">Raw</button></div>` : ""}<button type="button" class="button icon-button" data-copy-body="${side}" data-body-request-id="${requestId}" aria-label="Copy ${side} body" title="Copy body"><svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#copy"></use></svg></button></div></div>${canTree && effectiveMode === "tree" ? `<div class="body-tree-tools"><input type="search" data-body-search="${side}" placeholder="Find key or value" aria-label="Find in ${side} body"><button type="button" class="button" data-body-expand="${side}">Expand all</button><button type="button" class="button" data-body-collapse="${side}">Collapse</button></div>` : ""}<div class="body-content ${effectiveMode === "raw" ? "raw" : "tree"}" data-body-content="${side}">${content}</div></div>`;
}

export function graphqlViewerHtml(request, requestText, responseText) {
  const view = buildGraphqlView(request, requestText, responseText);
  const operation = view.operation || { kind: "query", name: "Anonymous" };
  return `<section class="graphql-viewer"><div class="graphql-header"><div><span class="eyebrow">GraphQL operation</span><h3>${escapeHtml(operation.name || "Anonymous")}</h3></div><span class="status-pill ${operation.kind === "mutation" ? "warn" : operation.kind === "subscription" ? "info" : "good"}">${escapeHtml(operation.kind || "query")}</span></div><div class="graphql-tabs"><section><div class="section-heading"><h3>Operation document</h3><button type="button" class="button icon-button" data-copy-graphql="query" aria-label="Copy GraphQL operation" title="Copy operation"><svg class="icon"><use href="vendor/lucide.svg#copy"></use></svg></button></div><pre class="graphql-query">${escapeHtml(view.query || "Operation document unavailable.")}</pre></section><section><h3>Variables</h3>${view.variables ? jsonTreeHtml(view.variables, { rootLabel: "variables", openDepth: 2 }) : `<p class="muted">No variables captured.</p>`}</section><section><div class="graphql-response-heading"><h3>Response data</h3><span class="section-note">${escapeHtml(jsonSummary(view.data))}</span></div>${view.errors.length ? `<div class="graphql-errors">${view.errors.map((error) => `<div><strong>${escapeHtml(error.message)}</strong><span>${escapeHtml(error.path.join(" → ") || "No path")}</span></div>`).join("")}</div>` : ""}${view.data !== null ? jsonTreeHtml(view.data, { rootLabel: "data", openDepth: 2 }) : `<p class="muted">No GraphQL data captured.</p>`}</section></div></section>`;
}

export function webSocketMessageHtml(message) {
  if (!message) return `<div class="empty-state">Select a message frame.</div>`;
  const parsed = parseBody(message.preview || "");
  const frame = parsed.kind === "json" && parsed.value && typeof parsed.value === "object" ? parsed.value : null;
  const graphql = frame && (frame.type || frame.payload?.data || frame.payload?.errors);
  const operation = frame?.payload?.operationName || frame?.payload?.query ? buildGraphqlView({}, JSON.stringify(frame.payload), JSON.stringify(frame.payload)).operation : null;
  const direction = message.direction === "outgoing" ? "Sent" : "Received";
  return `<div class="websocket-frame-inspector"><div class="frame-inspector-header"><div><span class="eyebrow">${direction} frame</span><h3>${escapeHtml(graphql ? `GraphQL ${frame.type || operation?.kind || "message"}` : `${parsed.kind} message`)}</h3></div><button type="button" class="button icon-button" data-copy-ws-message="${escapeHtml(message.id)}" aria-label="Copy WebSocket message" title="Copy message"><svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#copy"></use></svg></button></div><dl class="metric-list compact"><dt>Direction</dt><dd>${escapeHtml(message.direction)}</dd><dt>Captured</dt><dd>${escapeHtml(new Date(message.at).toLocaleTimeString())}</dd><dt>Payload</dt><dd>${escapeHtml(String(message.bytes || 0))} B</dd><dt>Transport</dt><dd>${escapeHtml(message.type || "unknown")}</dd></dl>${graphql ? `<div class="graphql-frame-banner"><svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#git-branch"></use></svg><span><strong>GraphQL over WebSocket</strong><small>${escapeHtml(frame.type || operation?.kind || "protocol frame")}${frame.id ? ` · operation ${escapeHtml(frame.id)}` : ""}</small></span></div>` : ""}${frame ? jsonTreeHtml(frame, { rootLabel: "frame", openDepth: 3 }) : highlightedBodyHtml(parsed)}</div>`;
}

export function jsonTreeHtml(value, { rootLabel = "root", openDepth = 1 } = {}) {
  return `<div class="json-tree">${renderNode(value, rootLabel, "$", 0, openDepth)}</div>`;
}

function renderNode(value, key, path, depth, openDepth) {
  if (value && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
    const type = Array.isArray(value) ? "array" : "object";
    return `<details class="json-branch" ${depth < openDepth ? "open" : ""} data-json-search-row><summary><span class="json-key">${escapeHtml(key)}</span><span class="json-meta">${type} · ${entries.length}</span></summary><div class="json-children">${entries.map(([childKey, child]) => renderNode(child, String(childKey), `${path}.${childKey}`, depth + 1, openDepth)).join("")}</div></details>`;
  }
  const type = value === null ? "null" : typeof value;
  const display = typeof value === "string" ? `"${value}"` : String(value);
  return `<div class="json-leaf" data-json-search-row title="${escapeHtml(path)}"><span class="json-key">${escapeHtml(key)}</span><span class="json-separator">:</span><span class="json-value ${type}">${escapeHtml(display)}</span></div>`;
}

function highlightedBodyHtml(parsed) {
  const source = parsed.formatted || parsed.source || "No body available.";
  const lines = source.split("\n");
  return `<pre class="payload-block formatted-payload">${lines.map((line, index) => `<span class="payload-line"><i>${index + 1}</i><code>${highlightLine(line, parsed.kind)}</code></span>`).join("")}</pre>`;
}

function highlightLine(line, kind) {
  if (kind !== "json" && kind !== "form") return escapeHtml(line);
  const match = line.match(/^(\s*)("(?:\\.|[^"])*")(\s*:\s*)?(.*)$/);
  if (!match) return escapeHtml(line);
  const [, spacing, quoted, separator = "", rest] = match;
  const restClass = /^(?:true|false)$/.test(rest.trim()) ? "boolean" : /^null$/.test(rest.trim()) ? "null" : /^-?\d/.test(rest.trim()) ? "number" : "string";
  return `${escapeHtml(spacing)}<span class="json-token key">${escapeHtml(quoted)}</span>${escapeHtml(separator)}<span class="json-token ${restClass}">${escapeHtml(rest)}</span>`;
}
