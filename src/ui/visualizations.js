import { nodeMetricValue } from "../core/visualization.js";

const d3 = globalThis.d3;

export function renderSiteConstellation(container, graph, options = {}) {
  if (!d3 || !container) return emptyController();
  container.replaceChildren();
  if (!graph.nodes.length) {
    container.innerHTML = `<div class="empty-state">Discover routes to build the sitemap constellation.</div>`;
    return emptyController();
  }
  const width = Math.max(640, container.clientWidth || 900);
  const height = Math.max(390, Math.min(560, 300 + graph.nodes.length * 4));
  const svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "group");
  const canvas = svg.append("g");
  const zoom = d3.zoom().scaleExtent([0.45, 3]).on("zoom", (event) => canvas.attr("transform", event.transform));
  svg.call(zoom).on("dblclick.zoom", null);
  const values = graph.nodes.map((node) => nodeMetricValue(node, options.metric));
  const radius = d3.scaleSqrt().domain([0, Math.max(1, ...values)]).range([9, 25]);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = d3.group(graph.nodes.filter((node) => node.parentId), (node) => node.parentId);
  const copies = graph.nodes.map((node) => ({ ...node, x: node.x / 1000 * width, y: Math.min(height - 36, node.y) }));
  const links = graph.edges.map((edge) => ({ ...edge, source: edge.from, target: edge.to }));
  const link = canvas.append("g").attr("class", "graph-links").selectAll("line").data(links).join("line")
    .attr("class", (edge) => `graph-edge ${edge.critical ? "active-path" : ""}`)
    .attr("data-from", (edge) => edge.from).attr("data-to", (edge) => edge.to);
  const node = canvas.append("g").attr("class", "graph-nodes").selectAll("g").data(copies).join("g")
    .attr("class", (item) => `graph-node route-node ${item.kind === "site" ? "site-root-node " : ""}state-${item.state}${item.id === options.selectedId ? " selected" : ""}${matchesSearch(item, options.search) ? "" : " search-muted"}`)
    .attr("data-graph-node-id", (item) => item.id);
  const nodeTarget = node.append("g").attr("class", "node-target").attr("data-node-id", (item) => item.id).attr("tabindex", 0).attr("role", "button")
    .attr("aria-label", (item) => `${item.label}, ${item.state}, ${item.score == null ? "not scored" : `score ${item.score}`}`)
    .on("click", (_, item) => options.onSelect?.(item.id))
    .on("focus", (_, item) => options.onSelect?.(item.id, { focusOnly: true }))
    .on("keydown", (event, item) => handleSiteKey(event, item, nodeById, children, options));
  nodeTarget.append("circle").attr("class", "node-hit").attr("r", (item) => radius(nodeMetricValue(item, options.metric)) + 7);
  nodeTarget.append("circle").attr("r", (item) => radius(nodeMetricValue(item, options.metric)))
    .attr("fill", (item) => scoreColor(item.score)).append("title")
    .text((item) => `${item.url}\n${metricLabel(options.metric)}: ${nodeMetricValue(item, options.metric)}\n${item.findings.length} findings`);
  nodeTarget.append("text").attr("class", "node-state-mark").attr("dy", 3).text((item) => stateMark(item.state));
  node.append("text").attr("class", "node-label").attr("y", (item) => radius(nodeMetricValue(item, options.metric)) + 14).text((item) => truncate(item.label, 22));
  const update = () => {
    link.attr("x1", (edge) => edge.source.x).attr("y1", (edge) => edge.source.y).attr("x2", (edge) => edge.target.x).attr("y2", (edge) => edge.target.y);
    node.attr("transform", (item) => `translate(${clamp(item.x, 28, width - 28)},${clamp(item.y, 28, height - 38)})`);
  };
  let simulation = null;
  if (options.motionEnabled && !document.hidden) {
    simulation = d3.forceSimulation(copies)
      .force("link", d3.forceLink(links).id((item) => item.id).distance(options.layout === "score" ? 90 : 72).strength(0.55))
      .force("charge", d3.forceManyBody().strength(-150))
      .force("collide", d3.forceCollide().radius((item) => radius(nodeMetricValue(item, options.metric)) + 22))
      .force("x", d3.forceX((item) => options.layout === "score" ? scoreX(item.score, width) : width / 2).strength(options.layout === "score" ? 0.24 : 0.05))
      .force("y", d3.forceY((item) => options.layout === "score" ? height / 2 : 55 + item.depth * 92).strength(options.layout === "score" ? 0.12 : 0.42))
      .alphaDecay(0.075).velocityDecay(0.48).on("tick", update);
    setTimeout(() => simulation?.stop(), 1900);
    nodeTarget.call(d3.drag()
      .on("start", (event, item) => { if (!event.active) simulation.alphaTarget(0.16).restart(); item.fx = item.x; item.fy = item.y; })
      .on("drag", (event, item) => { item.fx = event.x; item.fy = event.y; })
      .on("end", (event, item) => { if (!event.active) simulation.alphaTarget(0); item.fx = event.x; item.fy = event.y; setTimeout(() => simulation?.stop(), 500); }));
  } else {
    update();
  }
  return {
    destroy() { simulation?.stop(); },
    resetZoom() { svg.transition().duration(options.motionEnabled ? 180 : 0).call(zoom.transform, d3.zoomIdentity); },
    focusNode(id) { container.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.focus(); }
  };
}

export function renderDependencyGraph(container, graph, options = {}) {
  if (!d3 || !container) return emptyController();
  container.replaceChildren();
  if (!graph.nodes.length) {
    container.innerHTML = `<div class="empty-state">Capture initiated requests to build dependencies.</div>`;
    return emptyController();
  }
  const width = Math.max(640, container.clientWidth || 900);
  const height = Math.max(420, Math.min(620, 360 + graph.nodes.length * 1.5));
  const svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  const canvas = svg.append("g");
  const zoom = d3.zoom().scaleExtent([0.4, 3]).on("zoom", (event) => canvas.attr("transform", event.transform));
  svg.call(zoom).on("dblclick.zoom", null);
  const copies = graph.nodes.map((node, index) => ({ ...node, x: 65 + (index % 8) * (width - 130) / 7, y: 55 + Math.floor(index / 8) * 54 }));
  const links = graph.edges.map((edge) => ({ ...edge, source: edge.from, target: edge.to }));
  const adjacency = dependencyAdjacency(graph.edges);
  const link = canvas.append("g").selectAll("line").data(links).join("line").attr("class", (edge) => `graph-edge dependency-edge confidence-${edge.confidence}${edge.critical ? " critical" : ""}`);
  const node = canvas.append("g").selectAll("g").data(copies).join("g")
    .attr("class", (item) => `graph-node dependency-node${item.critical ? " critical" : ""}${item.status >= 400 ? " failed" : ""}`)
    .attr("data-graph-node-id", (item) => item.id);
  const nodeTarget = node.append("g").attr("class", "node-target").attr("data-node-id", (item) => item.id).attr("tabindex", 0).attr("role", "button")
    .attr("aria-label", (item) => `${item.label}, status ${item.status}, ${Math.round(item.duration)} milliseconds`)
    .on("click", (_, item) => options.onSelect?.(item.id))
    .on("keydown", (event, item) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); options.onSelect?.(item.id); } })
    .on("mouseenter focus", (_, item) => highlightFamily(item.id, adjacency, node, link))
    .on("mouseleave blur", () => { node.classed("related", false).classed("muted-node", false); link.classed("related", false).classed("muted-edge", false); });
  nodeTarget.append("rect").attr("class", "node-hit").attr("x", -13).attr("y", -13).attr("width", 26).attr("height", 26).attr("rx", 4);
  nodeTarget.append("rect").attr("x", -8).attr("y", -8).attr("width", 16).attr("height", 16).attr("rx", 3).append("title")
    .text((item) => `${item.label}\n${item.domain}\n${Math.round(item.duration)} ms`);
  node.append("text").attr("class", "node-label").attr("x", 13).attr("y", 4).text((item) => truncate(item.label, 24));
  const update = () => {
    link.attr("x1", (edge) => edge.source.x).attr("y1", (edge) => edge.source.y).attr("x2", (edge) => edge.target.x).attr("y2", (edge) => edge.target.y);
    node.attr("transform", (item) => `translate(${clamp(item.x, 18, width - 150)},${clamp(item.y, 20, height - 20)})`);
  };
  let simulation = null;
  if (options.motionEnabled && !document.hidden) {
    simulation = d3.forceSimulation(copies).force("link", d3.forceLink(links).id((item) => item.id).distance(70).strength(0.45))
      .force("charge", d3.forceManyBody().strength(-90)).force("collide", d3.forceCollide(28)).force("center", d3.forceCenter(width / 2, height / 2))
      .alphaDecay(0.08).velocityDecay(0.5).on("tick", update);
    setTimeout(() => simulation?.stop(), 1900);
    nodeTarget.call(d3.drag().on("start", (event, item) => { simulation.alphaTarget(0.12).restart(); item.fx = item.x; item.fy = item.y; }).on("drag", (event, item) => { item.fx = event.x; item.fy = event.y; }).on("end", (event, item) => { simulation.alphaTarget(0); item.fx = event.x; item.fy = event.y; setTimeout(() => simulation?.stop(), 450); }));
  } else update();
  return { destroy() { simulation?.stop(); }, resetZoom() { svg.transition().duration(options.motionEnabled ? 180 : 0).call(zoom.transform, d3.zoomIdentity); } };
}

export function renderJourneyTimeline(container, timeline, options = {}) {
  if (!d3 || !container) return emptyController();
  container.replaceChildren();
  const width = Math.max(640, container.clientWidth || 900);
  const rowHeight = 42;
  const margin = { top: 16, right: 18, bottom: 24, left: 88 };
  const height = margin.top + timeline.lanes.length * rowHeight + margin.bottom;
  const svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  const x = d3.scaleLinear().domain([timeline.start, timeline.end]).range([margin.left, width - margin.right]);
  const laneY = new Map(timeline.lanes.map((lane, index) => [lane, margin.top + index * rowHeight]));
  svg.selectAll("text.lane-label").data(timeline.lanes).join("text").attr("class", "lane-label").attr("x", 8).attr("y", (lane) => laneY.get(lane) + 24).text((lane) => lane === "api" ? "APIs" : titleCase(lane));
  svg.selectAll("line.lane-rule").data(timeline.lanes).join("line").attr("class", "lane-rule").attr("x1", margin.left).attr("x2", width - margin.right).attr("y1", (lane) => laneY.get(lane) + rowHeight - 4).attr("y2", (lane) => laneY.get(lane) + rowHeight - 4);
  const event = svg.selectAll("rect.timeline-event").data(timeline.events).join("rect").attr("class", (item) => `timeline-event lane-${item.lane}`)
    .attr("x", (item) => x(item.start)).attr("y", (item) => laneY.get(item.lane) + 8).attr("width", (item) => Math.max(5, x(item.start + item.duration) - x(item.start))).attr("height", 22).attr("rx", 3)
    .attr("tabindex", 0).attr("role", item => item.requestId ? "button" : "img").attr("aria-label", (item) => `${titleCase(item.lane)}: ${item.label}, ${Math.round(item.duration)} milliseconds`)
    .on("click", (_, item) => item.requestId && options.onRequest?.(item.requestId))
    .on("keydown", (e, item) => { if (item.requestId && ["Enter", " "].includes(e.key)) { e.preventDefault(); options.onRequest?.(item.requestId); } });
  event.append("title").text((item) => `${item.label}\n${Math.round(item.duration)} ms`);
  const playhead = svg.append("line").attr("class", "timeline-playhead").attr("y1", margin.top).attr("y2", height - margin.bottom + 5);
  const label = svg.append("text").attr("class", "timeline-playhead-label").attr("y", height - 5);
  const setProgress = (progress) => {
    const safe = clamp(progress, 0, 1);
    const position = margin.left + safe * (width - margin.left - margin.right);
    playhead.attr("x1", position).attr("x2", position);
    label.attr("x", clamp(position + 4, margin.left, width - 60)).text(`${Math.round(timeline.duration * safe)} ms`);
    event.classed("future", (item) => item.progress > safe);
  };
  setProgress(options.progress || 0);
  return { destroy() {}, setProgress };
}

export function renderNetworkOverview(container, series, options = {}) {
  if (!d3 || !container) return emptyController();
  container.replaceChildren();
  if (!series.bins.length) {
    container.innerHTML = `<div class="empty-state compact-empty">Network activity appears after requests are captured.</div>`;
    return emptyController();
  }
  const width = Math.max(640, container.clientWidth || 900);
  const height = 92;
  const margin = { top: 8, right: 10, bottom: 16, left: 10 };
  const svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  const x = d3.scaleLinear().domain([series.start, series.end]).range([margin.left, width - margin.right]);
  const yCount = d3.scaleLinear().domain([0, Math.max(1, ...series.bins.map((bin) => bin.count))]).range([height - margin.bottom, margin.top]);
  const yBytes = d3.scaleLinear().domain([0, Math.max(1, ...series.bins.map((bin) => bin.bytes))]).range([height - margin.bottom, margin.top]);
  svg.selectAll("rect.activity-bin").data(series.bins).join("rect").attr("class", "activity-bin")
    .attr("x", (bin) => x(bin.start)).attr("y", (bin) => yCount(bin.count)).attr("width", (bin) => Math.max(1, x(bin.end) - x(bin.start) - 1)).attr("height", (bin) => height - margin.bottom - yCount(bin.count));
  const line = d3.line().x((bin) => x((bin.start + bin.end) / 2)).y((bin) => yBytes(bin.bytes)).curve(d3.curveMonotoneX);
  svg.append("path").datum(series.bins).attr("class", "activity-bytes-line").attr("d", line);
  const marker = svg.append("line").attr("class", "network-hover-marker").attr("y1", margin.top).attr("y2", height - margin.bottom).style("display", "none");
  let applying = false;
  const brush = d3.brushX().extent([[margin.left, margin.top], [width - margin.right, height - margin.bottom]]).on("end", (event) => {
    if (applying) return;
    if (!event.selection) return options.onBrush?.(null);
    const [from, to] = event.selection.map(x.invert);
    options.onBrush?.({ timeStart: Math.round(from), timeEnd: Math.round(to) });
  });
  const brushLayer = svg.append("g").attr("class", "network-brush").call(brush);
  if (options.selection?.timeStart && options.selection?.timeEnd) {
    applying = true;
    brushLayer.call(brush.move, [x(options.selection.timeStart), x(options.selection.timeEnd)]);
    applying = false;
  }
  return {
    destroy() {},
    setMarker(requestId) {
      const item = series.markers.find((candidate) => candidate.id === requestId);
      marker.style("display", item ? null : "none");
      if (item) marker.attr("x1", x(item.time)).attr("x2", x(item.time));
    }
  };
}

export function renderSparkline(container, values = []) {
  if (!d3 || !container) return;
  container.replaceChildren();
  if (values.length < 2) return;
  const width = Math.max(180, container.clientWidth || 260);
  const height = 44;
  const svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("aria-label", `Benchmark score trend: ${values.join(", ")}`);
  const x = d3.scaleLinear().domain([0, values.length - 1]).range([4, width - 4]);
  const y = d3.scaleLinear().domain([Math.min(...values) - 3, Math.max(...values) + 3]).range([height - 6, 6]);
  svg.append("path").datum(values).attr("class", "sparkline-path").attr("d", d3.line().x((_, index) => x(index)).y((value) => y(value)).curve(d3.curveMonotoneX));
  svg.selectAll("circle").data(values).join("circle").attr("cx", (_, index) => x(index)).attr("cy", (value) => y(value)).attr("r", 2.5);
}

function handleSiteKey(event, item, byId, children, options) {
  if (["Enter", " "].includes(event.key)) { event.preventDefault(); options.onSelect?.(item.id); return; }
  let target = null;
  if (event.key === "ArrowUp") target = byId.get(item.parentId);
  if (event.key === "ArrowDown") target = children.get(item.id)?.[0];
  if (["ArrowLeft", "ArrowRight"].includes(event.key) && item.parentId) {
    const siblings = children.get(item.parentId) || [];
    const index = siblings.findIndex((candidate) => candidate.id === item.id);
    target = siblings[(index + (event.key === "ArrowRight" ? 1 : -1) + siblings.length) % siblings.length];
  }
  if (target) { event.preventDefault(); options.onNavigate?.(target.id); }
}

function dependencyAdjacency(edges) {
  const parents = new Map();
  const children = new Map();
  for (const edge of edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, []);
    if (!children.has(edge.from)) children.set(edge.from, []);
    parents.get(edge.to).push(edge.from);
    children.get(edge.from).push(edge.to);
  }
  return { parents, children };
}

function highlightFamily(id, adjacency, nodes, links) {
  const related = new Set([id]);
  const walk = (map, current) => { for (const next of map.get(current) || []) if (!related.has(next)) { related.add(next); walk(map, next); } };
  walk(adjacency.parents, id);
  walk(adjacency.children, id);
  nodes.classed("related", (item) => related.has(item.id)).classed("muted-node", (item) => !related.has(item.id));
  links.classed("related", (edge) => related.has(edge.source.id || edge.source) && related.has(edge.target.id || edge.target)).classed("muted-edge", (edge) => !(related.has(edge.source.id || edge.source) && related.has(edge.target.id || edge.target)));
}

function emptyController() { return { destroy() {}, resetZoom() {}, focusNode() {}, setProgress() {}, setMarker() {} }; }
function scoreColor(score) { return score == null ? "var(--graph-queued)" : score >= 80 ? "var(--graph-good)" : score >= 60 ? "var(--graph-warn)" : "var(--graph-bad)"; }
function scoreX(score, width) { return score == null ? width * 0.16 : score >= 80 ? width * 0.78 : score >= 60 ? width * 0.52 : width * 0.27; }
function stateMark(state) { return ({ group: "S", queued: "·", scanning: "↻", complete: "✓", failed: "!" })[state] || "·"; }
function metricLabel(metric) { return ({ transferSize: "Transfer bytes", lcp: "LCP", findings: "Findings" })[metric] || metric; }
function matchesSearch(item, search) { return !search || `${item.url} ${item.label}`.toLowerCase().includes(String(search).toLowerCase()); }
function truncate(value, length) { const text = String(value || ""); return text.length > length ? `${text.slice(0, length - 1)}…` : text; }
function titleCase(value) { const text = String(value || ""); return text.charAt(0).toUpperCase() + text.slice(1); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
