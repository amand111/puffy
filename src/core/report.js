import { analyzeServices, buildDependencies, buildFindings, buildNarrative, compareCaptures, detectPatterns, summarize, summarizeStep } from "./analysis.js";
import { buildAuditNarrative } from "./audit.js";
import { escapeHtml, formatBytes, formatMs, safeNarrativeHtml } from "./render.js";
import { buildDependencyGraph, buildJourneyTimeline, buildSiteGraph } from "./visualization.js";

export function buildReportHtml(session, { comparisonCaptures = [], visibleCode = "" } = {}) {
  const summary = summarize(session);
  const narrative = buildNarrative(session);
  const findings = buildFindings(session);
  const services = analyzeServices(session);
  const patterns = detectPatterns(session);
  const dependencies = buildDependencies(session);
  const comparison = comparisonCaptures.length === 2 ? compareCaptures(comparisonCaptures[0], comparisonCaptures[1]) : null;
  const audit = session.audit || {};
  const securityFindings = audit.securityFindings || [];
  const auditFindings = audit.findings || [];
  const siteRun = session.siteAudits?.at(-1);
  const siteGraph = buildSiteGraph(siteRun?.routes?.map((route) => route.url) || [], siteRun, siteRun?.originalUrl || session.url);
  const dependencyGraph = buildDependencyGraph(session, 150);
  const requestAnchor = (id, label) => `<a href="#request-${escapeHtml(id)}">${escapeHtml(label)}</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Puffy Deep Debugger Report</title>
<style>
:root{--bg:#f3f5f7;--surface:#fff;--text:#172027;--muted:#63707a;--line:#dce2e7;--accent:#147d64;--danger:#b43a32;--warning:#a86114;--blue:#356f9f}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:26px max(24px,calc((100vw - 1280px)/2));background:#15191d;color:#fff}header h1{margin:0;font-size:26px}header p{margin:5px 0 0;color:#aeb7be;overflow-wrap:anywhere}main{max-width:1280px;margin:auto;padding:20px 24px 40px}h2{margin:0 0 12px;font-size:18px}h3{margin:0}a{color:#27658e;text-underline-offset:2px}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}.card,.panel{border:1px solid var(--line);border-radius:8px;background:#fff}.card{padding:12px}.card span,.muted{color:var(--muted)}.card span{display:block;font-size:10px;text-transform:uppercase}.card strong{display:block;margin-top:4px;font-size:18px}.panel{margin-top:14px;padding:16px}.brief{border-left:4px solid var(--accent)}.step,.finding,.service,.pattern,.chain{margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:6px}.finding{display:grid;grid-template-columns:90px 1fr 1fr;gap:12px}.high,.critical,.serious{color:var(--danger)}.medium,.moderate{color:var(--warning)}.low,.minor{color:var(--blue)}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:7px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#eef1f4}.url{max-width:430px;overflow-wrap:anywhere}pre{padding:12px;border-radius:6px;background:#11171b;color:#dce7eb;white-space:pre-wrap;overflow-wrap:anywhere}.static-graph{width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#f8fafb}.static-edge{stroke:#9aabb3;stroke-width:1.5}.static-edge.inferred{stroke-dasharray:5 4}.static-edge.critical{stroke:var(--blue);stroke-width:2.5}.static-node{stroke:#fff;stroke-width:2}.static-label{fill:var(--text);font-size:9px}.report-lane{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px;align-items:center;margin:6px 0}.report-lane-track{position:relative;height:22px;border-bottom:1px solid var(--line);background:#f8fafb}.report-event{position:absolute;top:5px;min-width:4px;height:12px;border-radius:2px;background:var(--accent)}.report-event.interaction{background:var(--warning)}.report-event.longtask{background:var(--danger)}@media(max-width:900px){.grid{grid-template-columns:repeat(3,1fr)}.finding{grid-template-columns:70px 1fr}.finding div:last-child{grid-column:2}}
</style></head><body>
<header><h1>Puffy Deep Debugger Report</h1><p>${escapeHtml(session.url || "Unknown URL")} · Generated ${escapeHtml(new Date().toLocaleString())}</p></header><main>
<section class="grid">${[
    ["Score", `${summary.score}/100`], ["Journey steps", session.steps.length], ["Requests", summary.requestCount], ["Transferred", formatBytes(summary.transferSize)], ["INP-style latency", formatMs(summary.inp)], ["Failures", summary.errors]
  ].map(([label, value]) => `<article class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("")}</section>
<section class="panel brief"><h2>Local analysis</h2>${narrative.paragraphs.map((paragraph) => `<p>${safeNarrativeHtml(paragraph)}</p>`).join("")}<ol>${narrative.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol></section>
${audit.status === "complete" ? `<section class="panel brief"><h2>Full audit · ${audit.overallScore}/100</h2>${buildAuditNarrative(session).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}<div class="grid">${audit.categoryScores.map((item) => `<article class="card"><span>${escapeHtml(item.category)}</span><strong>${item.score ?? "--"}</strong><small>${item.coverage}% coverage</small></article>`).join("")}</div></section>` : ""}
${auditFindings.length ? `<section class="panel"><h2>Accessibility, SEO, and quality findings</h2>${auditFindings.map((finding) => `<article class="finding"><strong class="${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</strong><div><h3>${escapeHtml(finding.title)}</h3><p>${escapeHtml(finding.description)}</p></div><div><h3>Fix</h3><p>${escapeHtml(finding.fixSuggestion)}</p></div></article>`).join("")}</section>` : ""}
${securityFindings.length ? `<section class="panel"><h2>Security and privacy analysis · ${audit.securityRisk}/100 risk</h2>${securityFindings.map((finding) => `<article class="finding"><strong class="${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)} · ${escapeHtml(finding.confidence)}</strong><div><h3>${finding.requestIds?.length ? requestAnchor(finding.requestIds[0], finding.title) : escapeHtml(finding.title)}</h3><p>${escapeHtml(finding.description)}</p></div><div><h3>Fix</h3><p>${escapeHtml(finding.fixSuggestion)}</p></div></article>`).join("")}</section>` : ""}
<section class="panel"><h2>Journey timeline</h2>${session.steps.map((step) => {
    const item = summarizeStep(session, step);
    return `<article class="step"><h3>${escapeHtml(step.name)}</h3><span class="muted">${escapeHtml(new Date(step.startedAt).toLocaleString())} · ${escapeHtml(step.status)}</span><p>${item.requestCount} requests · ${formatBytes(item.transferSize)} · ${item.services} services · ${item.longTasks} long tasks · max interaction ${formatMs(item.maxInteraction)}</p>${staticJourneyTimeline(buildJourneyTimeline(session, step))}</article>`;
  }).join("")}</section>
<section class="panel"><h2>Findings</h2>${findings.map((finding) => `<article class="finding"><strong class="${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</strong><div><h3>${escapeHtml(finding.title)}</h3><p>${escapeHtml(finding.evidence)}</p></div><div><h3>Action</h3><p>${escapeHtml(finding.recommendation)}</p></div></article>`).join("") || "<p>No findings.</p>"}</section>
<section class="panel"><h2>Detected request patterns</h2>${patterns.map((pattern) => `<article class="pattern"><h3>${escapeHtml(pattern.title)}</h3><p>${escapeHtml(pattern.detail)}</p></article>`).join("") || "<p>No repeated request patterns detected.</p>"}</section>
<section class="panel"><h2>Critical dependency chain</h2><p>${escapeHtml(formatMs(dependencies.criticalWeight))} cumulative request time</p>${staticDependencyGraph(dependencyGraph)}${dependencies.criticalChain.map((request, index) => `<div class="chain"><strong>${index + 1}. ${escapeHtml(request.method)} ${escapeHtml(request.domain + request.endpointTemplate)}</strong><span class="muted"> · ${escapeHtml(formatMs(request.time))}</span></div>`).join("") || "<p>No chain available.</p>"}</section>
<section class="panel"><h2>Backend services</h2>${services.map((service) => `<article class="service"><h3>${escapeHtml(service.domain)}</h3><p>${escapeHtml(service.purpose)} · ${service.count} calls · p95 ${formatMs(service.p95)} · ${service.errors} failures · ${formatBytes(service.dataPassing)} data</p><p>${escapeHtml(service.assessment)}</p></article>`).join("") || "<p>No services detected.</p>"}</section>
${siteRun?.routes?.length ? `<section class="panel"><h2>Site audit route matrix and topology</h2>${staticSiteGraph(siteGraph)}<p class="muted">Node color: green 80+, amber 60-79, red below 60, gray unavailable. Lines represent closest URL path ancestors.</p><table><thead><tr><th>Route</th><th>Score</th><th>Findings</th><th>LCP</th><th>Transfer</th></tr></thead><tbody>${siteRun.routes.map((route) => `<tr><td class="url">${escapeHtml(route.url)}</td><td>${route.score ?? "--"}</td><td>${route.findings.length}</td><td>${formatMs(route.metrics?.lcp || 0)}</td><td>${formatBytes(route.metrics?.transferSize || 0)}</td></tr>`).join("")}</tbody></table></section>` : ""}
${comparison ? `<section class="panel"><h2>Saved capture comparison</h2><table><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>${comparison.metrics.map((metric) => `<tr><td>${escapeHtml(metric.label)}</td><td>${escapeHtml(metric.before)}</td><td>${escapeHtml(metric.after)}</td><td class="${metric.improved ? "low" : "high"}">${metric.delta > 0 ? "+" : ""}${metric.delta.toFixed(1)} (${metric.percent.toFixed(1)}%)</td></tr>`).join("")}</tbody></table></section>` : ""}
<section class="panel"><h2>Network requests</h2><table><thead><tr><th>Step</th><th>Method</th><th>Status</th><th>Request</th><th>Duration</th><th>Transfer</th><th>Initiator</th></tr></thead><tbody>${session.requests.map((request) => `<tr id="request-${escapeHtml(request.id)}"><td>${escapeHtml(session.steps.find((step) => step.id === request.stepId)?.name || "Unassigned")}</td><td>${escapeHtml(request.method)}</td><td>${request.status}</td><td class="url"><a href="#request-${escapeHtml(request.id)}">${escapeHtml(request.url)}</a></td><td>${formatMs(request.time)}</td><td>${formatBytes(request.transferSize)}</td><td>${escapeHtml(request.initiator?.type || request.resourceTiming?.initiatorType || "unknown")}</td></tr>`).join("")}</tbody></table></section>
<section class="panel"><h2>Visible page assets</h2><pre>${escapeHtml(visibleCode)}</pre></section>
</main></body></html>`;
}

function staticSiteGraph(graph) {
  if (!graph.nodes.length) return "<p>No route topology available.</p>";
  const height = Math.max(180, Math.min(720, 100 + Math.max(...graph.nodes.map((node) => node.depth)) * 118));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.map((edge) => { const from = byId.get(edge.from); const to = byId.get(edge.to); return `<line class="static-edge" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`; }).join("");
  const nodes = graph.nodes.map((node) => `<g><circle class="static-node" cx="${node.x}" cy="${node.y}" r="9" fill="${reportScoreColor(node.score)}"/><text class="static-label" x="${node.x + 13}" y="${node.y + 3}">${escapeHtml(node.label.slice(0, 24))}</text></g>`).join("");
  return `<svg class="static-graph" viewBox="0 0 1000 ${height}" role="img" aria-label="Static sitemap topology">${edges}${nodes}</svg>`;
}

function staticDependencyGraph(graph) {
  if (!graph.criticalChainIds.length) return "";
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const width = 1000;
  const spacing = width / (graph.criticalChainIds.length + 1);
  const points = new Map(graph.criticalChainIds.map((id, index) => [id, { x: spacing * (index + 1), y: 55 }]));
  const lines = graph.edges.filter((edge) => edge.critical && points.has(edge.from) && points.has(edge.to)).map((edge) => `<line class="static-edge critical ${edge.confidence}" x1="${points.get(edge.from).x}" y1="55" x2="${points.get(edge.to).x}" y2="55"/>`).join("");
  const nodes = graph.criticalChainIds.map((id) => { const point = points.get(id); const node = byId.get(id); return `<g><rect x="${point.x - 7}" y="48" width="14" height="14" rx="3" fill="#356f9f"/><text class="static-label" text-anchor="middle" x="${point.x}" y="82">${escapeHtml(node.label.slice(0, 20))}</text></g>`; }).join("");
  return `<svg class="static-graph" viewBox="0 0 ${width} 100" role="img" aria-label="Critical dependency highlight">${lines}${nodes}</svg>`;
}

function staticJourneyTimeline(timeline) {
  return timeline.lanes.map((lane) => `<div class="report-lane"><strong>${escapeHtml(lane)}</strong><div class="report-lane-track">${timeline.events.filter((event) => event.lane === lane).map((event) => `<span class="report-event ${escapeHtml(lane)}" title="${escapeHtml(event.label)}" style="left:${(event.progress * 100).toFixed(2)}%;width:${Math.max(.5, event.duration / timeline.duration * 100).toFixed(2)}%"></span>`).join("")}</div></div>`).join("");
}

function reportScoreColor(score) {
  if (!Number.isFinite(score)) return "#87949b";
  return score >= 80 ? "#168668" : score >= 60 ? "#c47b20" : "#c64b43";
}
