import { escapeHtml, formatBytes, formatMs } from "./utils.js";

export { escapeHtml, formatBytes, formatMs };

export function statusTone(status) {
  if (Number(status) >= 400) return "bad";
  if (Number(status) >= 300) return "warn";
  return "good";
}

export function scoreDescriptor(score) {
  if (score >= 90) return { label: "Excellent", tone: "good" };
  if (score >= 75) return { label: "Healthy", tone: "good" };
  if (score >= 55) return { label: "Needs work", tone: "warn" };
  return { label: "Poor", tone: "bad" };
}

export function waterfallHtml(request) {
  const connect = Math.max(0, Number(request.timings?.dns || 0)) + Math.max(0, Number(request.timings?.connect || 0)) + Math.max(0, Number(request.timings?.ssl || 0));
  const wait = Math.max(0, Number(request.timings?.wait || 0));
  const receive = Math.max(0, Number(request.timings?.receive || 0));
  const total = Math.max(1, connect + wait + receive);
  return `<div class="waterfall-track" title="Connect ${formatMs(connect)}, wait ${formatMs(wait)}, receive ${formatMs(receive)}"><span class="timing-connect" style="width:${Math.max(1, connect / total * 100)}%"></span><span class="timing-wait" style="width:${Math.max(1, wait / total * 100)}%"></span><span class="timing-receive" style="width:${Math.max(1, receive / total * 100)}%"></span></div>`;
}

export function emptyState(message) {
  return `<p class="empty-state">${escapeHtml(message)}</p>`;
}

export function safeNarrativeHtml(value) {
  return escapeHtml(value)
    .replaceAll("&lt;strong&gt;", "<strong>")
    .replaceAll("&lt;/strong&gt;", "</strong>");
}

export function miniStats(rows) {
  return rows.map(([label, value, note]) => `<article class="mini-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note || "")}</small></article>`).join("");
}
