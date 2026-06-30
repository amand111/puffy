import { buildDependencies } from "./analysis.js";
import { hashString } from "./utils.js";

/** @typedef {{id:string,url:string,label:string,title:string,path:string,depth:number,parentId:string|null,state:"group"|"queued"|"scanning"|"complete"|"failed",kind:"site"|"route",virtual:boolean,score:number|null,metrics:object,categoryScores:Array,findings:Array,requestIds:string[],x:number,y:number}} SiteGraphNode */
/** @typedef {{id:string,from:string,to:string,confidence:"exact"|"inferred",reason:string,critical:boolean}} GraphEdge */
/** @typedef {{id:string,lane:"navigation"|"api"|"interaction"|"longtask",label:string,start:number,duration:number,requestId:string|null,progress:number}} TimelineEvent */
/** @typedef {{theme:"light"|"dark",motionEnabled:boolean,siteLayout:"topology"|"score",siteMetric:"transferSize"|"lcp"|"findings",timelineSpeed:1|2}} VisualizationPreferences */

export const DEFAULT_VISUALIZATION_PREFERENCES = Object.freeze({
  theme: "light",
  motionEnabled: true,
  siteLayout: "topology",
  siteMetric: "transferSize",
  timelineSpeed: 1
});

export function normalizeRouteUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    url.hash = "";
    const sorted = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    url.search = "";
    for (const [key, value] of sorted) url.searchParams.append(key, value);
    return url.href;
  } catch {
    return String(raw || "").split("#")[0];
  }
}

export function buildSiteGraph(queue = [], run = null, originalUrl = "", activeUrl = "") {
  const base = originalUrl || queue[0] || run?.routes?.[0]?.url || "https://invalid.local/";
  const resultByUrl = new Map((run?.routes || []).map((route) => [normalizeRouteUrl(route.url, base), route]));
  const urls = [...new Set([originalUrl, ...queue, ...(run?.routes || []).map((route) => route.url)].filter(Boolean).map((url) => normalizeRouteUrl(url, base)))].slice(0, 100);
  const active = activeUrl ? normalizeRouteUrl(activeUrl, base) : "";
  const nodes = urls.map((url) => {
    const parsed = safeUrl(url, base);
    const route = resultByUrl.get(url);
    const path = parsed.pathname || "/";
    const failed = Boolean(route?.failed || route?.status === "failed");
    const state = url === active ? "scanning" : failed ? "failed" : route ? "complete" : "queued";
    return {
      id: `route-${hashString(url)}`,
      url,
      label: routeLabel(parsed),
      title: route?.title || "",
      path,
      depth: pathDepth(path),
      parentId: null,
      kind: "route",
      virtual: false,
      state,
      score: Number.isFinite(route?.score) ? route.score : null,
      metrics: route?.metrics || {},
      categoryScores: route?.categoryScores || [],
      findings: route?.findings || [],
      requestIds: [...new Set((route?.findings || []).flatMap((finding) => finding.requestIds || finding.evidenceIds || []))],
      x: 0,
      y: 0
    };
  });
  const baseUrl = safeUrl(base, base);
  const realRoot = nodes.find((node) => safeUrl(node.url, base).origin === baseUrl.origin && node.path === "/");
  if (!realRoot && nodes.length) {
    nodes.unshift({
      id: `site-${hashString(baseUrl.origin)}`,
      url: `${baseUrl.origin}/`, label: baseUrl.hostname, title: "Site root", path: "/", depth: 0, parentId: null,
      kind: "site", virtual: true, state: "group", score: null, metrics: {}, categoryScores: [], findings: [], requestIds: [], x: 0, y: 0
    });
    if (nodes.length > 100) nodes.pop();
  }
  const byOriginPath = new Map(nodes.map((node) => {
    const url = safeUrl(node.url, base);
    return [`${url.origin}${url.pathname}`, node];
  }));
  const root = nodes.find((node) => node.kind === "site") || nodes.find((node) => node.path === "/") || [...nodes].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))[0] || null;
  for (const node of nodes) {
    const url = safeUrl(node.url, base);
    let parent = null;
    for (const ancestorPath of pathAncestors(url.pathname)) {
      const candidate = byOriginPath.get(`${url.origin}${ancestorPath}`);
      if (candidate && candidate.id !== node.id) { parent = candidate; break; }
    }
    if (!parent && root && root.id !== node.id) parent = root;
    node.parentId = parent?.id || null;
  }
  assignStaticSitePositions(nodes);
  const edges = nodes.filter((node) => node.parentId).map((node) => ({
    id: `site-edge-${node.parentId}-${node.id}`,
    from: node.parentId,
    to: node.id,
    confidence: "exact",
    reason: "closest URL path ancestor",
    critical: node.state === "scanning"
  }));
  return { nodes, edges, rootId: root?.id || null };
}

export function buildDependencyGraph(session, limit = 150) {
  const dependency = buildDependencies(session);
  const requests = session.requests || [];
  const byId = new Map(requests.map((request) => [request.id, request]));
  const parentByChild = new Map(dependency.edges.map((edge) => [edge.to, edge.from]));
  const criticalIds = new Set(dependency.criticalChain.map((request) => request.id));
  const priority = [...requests].sort((a, b) => dependencyPriority(b, criticalIds) - dependencyPriority(a, criticalIds));
  const selected = new Set();
  for (const request of [...dependency.criticalChain, ...priority]) {
    const family = [];
    const seen = new Set();
    let current = request;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (!selected.has(current.id)) family.unshift(current.id);
      current = byId.get(parentByChild.get(current.id));
    }
    if (selected.size + family.length > limit) continue;
    for (const id of family) selected.add(id);
    if (selected.size >= limit) break;
  }
  const nodes = [...selected].map((id) => {
    const request = byId.get(id);
    return {
      id,
      request,
      label: `${request.method} ${request.endpointTemplate}`,
      domain: request.domain,
      status: request.status,
      duration: Number(request.time || 0),
      transferSize: Number(request.transferSize || 0),
      critical: criticalIds.has(id)
    };
  });
  const edges = dependency.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)).map((edge) => ({
    id: `dependency-edge-${edge.from}-${edge.to}`,
    from: edge.from,
    to: edge.to,
    confidence: edge.confidence,
    reason: edge.reason,
    critical: criticalIds.has(edge.from) && criticalIds.has(edge.to)
  }));
  return { nodes, edges, criticalChainIds: dependency.criticalChain.map((request) => request.id).filter((id) => selected.has(id)), criticalWeight: dependency.criticalWeight };
}

export function buildJourneyTimeline(session, step) {
  if (!step) return { start: 0, end: 1, duration: 1, events: [], lanes: ["navigation", "api", "interaction", "longtask"] };
  const start = new Date(step.startedAt).getTime();
  const declaredEnd = step.endedAt ? new Date(step.endedAt).getTime() : Date.now();
  const requestIds = new Set(step.requestIds || []);
  const longTaskIds = new Set(step.longTaskIds || []);
  const interactionIds = new Set(step.interactionIds || []);
  const events = [];
  (step.navigationUrls || []).forEach((url, index) => events.push({ id: `navigation-${index}-${hashString(url)}`, lane: "navigation", label: url, start: start + index, duration: 1, requestId: null }));
  for (const request of session.requests || []) {
    if (!requestIds.has(request.id)) continue;
    events.push({ id: request.id, lane: "api", label: `${request.method} ${request.domain}${request.endpointTemplate}`, start: new Date(request.startedDateTime).getTime(), duration: Math.max(1, Number(request.time || 0)), requestId: request.id });
  }
  for (const interaction of session.telemetry?.interactions || []) {
    if (!interactionIds.has(interaction.id)) continue;
    events.push({ id: interaction.id, lane: "interaction", label: interaction.name || "Interaction", start: Number(interaction.absoluteStart || start), duration: Math.max(1, Number(interaction.duration || 0)), requestId: null });
  }
  for (const task of session.telemetry?.longTasks || []) {
    if (!longTaskIds.has(task.id)) continue;
    events.push({ id: task.id, lane: "longtask", label: task.name || "Long task", start: Number(task.absoluteStart || start), duration: Math.max(1, Number(task.duration || 0)), requestId: null });
  }
  events.sort((a, b) => a.start - b.start || a.lane.localeCompare(b.lane) || a.id.localeCompare(b.id));
  const end = Math.max(start + 1, declaredEnd, ...events.map((event) => event.start + event.duration));
  const duration = end - start;
  return { start, end, duration, lanes: ["navigation", "api", "interaction", "longtask"], events: events.map((event) => ({ ...event, progress: Math.max(0, Math.min(1, (event.start - start) / duration)) })) };
}

export function buildNetworkSeries(requests = [], binCount = 40) {
  if (!requests.length) return { start: 0, end: 1, duration: 1, bins: [], markers: [] };
  const times = requests.map((request) => new Date(request.startedDateTime).getTime());
  const start = Math.min(...times);
  const end = Math.max(start + 1, ...requests.map((request, index) => times[index] + Math.max(1, Number(request.time || 0))));
  const duration = end - start;
  const count = Math.max(1, Math.min(100, Number(binCount) || 40));
  const bins = Array.from({ length: count }, (_, index) => ({ index, start: start + duration * index / count, end: start + duration * (index + 1) / count, count: 0, bytes: 0 }));
  const markers = requests.map((request, index) => {
    const ratio = Math.max(0, Math.min(0.999999, (times[index] - start) / duration));
    const bin = bins[Math.floor(ratio * count)];
    bin.count += 1;
    bin.bytes += Number(request.transferSize || 0);
    return { id: request.id, time: times[index], ratio };
  });
  return { start, end, duration, bins, markers };
}

export function brushRangeToTimestamps(startRatio, endRatio, start, end) {
  const low = Math.max(0, Math.min(1, Math.min(startRatio, endRatio)));
  const high = Math.max(0, Math.min(1, Math.max(startRatio, endRatio)));
  const duration = Math.max(0, end - start);
  return { timeStart: Math.round(start + duration * low), timeEnd: Math.round(start + duration * high) };
}

export function nodeMetricValue(node, metric = "transferSize") {
  if (metric === "findings") return node.findings?.length || 0;
  return Number(node.metrics?.[metric] || 0);
}

function dependencyPriority(request, criticalIds) {
  return (request.status >= 400 ? 1e12 : 0) + (criticalIds.has(request.id) ? 1e11 : 0) + Number(request.time || 0) * 1e6 + Number(request.transferSize || 0);
}

function safeUrl(raw, base) {
  try { return new URL(raw, base); } catch { return new URL("https://invalid.local/"); }
}

function routeLabel(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) || url.hostname || "/");
}

function pathDepth(path) {
  return path.split("/").filter(Boolean).length;
}

function pathAncestors(path) {
  const parts = path.split("/").filter(Boolean);
  const result = [];
  for (let size = parts.length - 1; size >= 0; size -= 1) result.push(size ? `/${parts.slice(0, size).join("/")}` : "/");
  return result;
}

function assignStaticSitePositions(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    if (!groups.has(node.depth)) groups.set(node.depth, []);
    groups.get(node.depth).push(node);
  }
  for (const [depth, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.path.localeCompare(b.path) || a.url.localeCompare(b.url));
    group.forEach((node, index) => {
      node.x = Math.round(80 + (840 * (index + 1)) / (group.length + 1));
      node.y = Math.round(64 + depth * 118);
    });
  }
}
