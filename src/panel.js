import { analyzeServices, associateResourceTimings, buildDependencies, buildFindings, buildNarrative, compareCaptures, detectPatterns, isServiceRequest, normalizeRequest, summarize, summarizeStep } from "./core/analysis.js";
import { DemoCaptureAdapter, DevToolsCaptureAdapter } from "./core/capture.js";
import { AuditEngine, buildAuditNarrative } from "./core/audit.js";
import { SiteCrawler } from "./core/crawler.js";
import { DEFAULT_AUDIT_PROFILE, assignRequestToStep, createSession, getActiveStep, mergeTelemetry, recordNavigation, serializableSession, startStep as startJourneyStep, stopActiveStep } from "./core/model.js";
import { MemoryStorageArea, SavedCaptureStore } from "./core/persistence.js";
import { emptyState, escapeHtml, formatBytes, formatMs, miniStats, safeNarrativeHtml, scoreDescriptor, statusTone, waterfallHtml } from "./core/render.js";
import { buildReportHtml } from "./core/report.js";
import { auditBodyPreview } from "./core/security.js";
import { validateAuditProfile } from "./core/scoring.js";
import { getDomain, getPathname, isSameSite } from "./core/utils.js";

const devtoolsAvailable = Boolean(globalThis.chrome?.devtools?.network && globalThis.chrome?.devtools?.inspectedWindow);
const PAGE_SIZE = 100;

function emptyNetworkFilters() {
  return { search: "", steps: [], methods: [], statuses: [], types: [], domains: [], party: "all", security: "all", cache: "all", compression: "all", body: "all", apiStyle: "all", protocols: [], initiators: [], confidence: [], durationMin: 0, durationMax: 0, transferMin: 0, transferMax: 0, timeStart: 0, timeEnd: 0 };
}

const state = {
  recording: true,
  benchmarking: false,
  currentSession: createSession(),
  benchmarkRuns: [],
  savedCaptures: [],
  compareSelection: new Set(),
  comparison: null,
  selectedRequestId: null,
  selectedServiceDomain: null,
  selectedStepId: null,
  bodyPreviews: new Map(),
  requestPage: 1,
  networkFilters: emptyNetworkFilters(),
  apiGroups: new Map(),
  inspectorGroup: [],
  inspectorIndex: 0,
  auditSeverity: "all",
  routeQueue: [],
  siteAuditRunning: false,
  renderQueued: false,
  pendingDeleteId: null
};
state.selectedStepId = state.currentSession.steps[0].id;

const ids = [
  "targetUrl", "pageTitle", "toggleRecording", "clearSession", "reloadCapture", "benchmarkRuns", "runBenchmark", "exportReport",
  "stepName", "startStep", "stopStep", "activeStepLabel", "stepStatus", "stepCountBadge", "requestCount", "requestSubtext", "inpMetric",
  "longTaskMetric", "transferSize", "dataPassing", "slowestCall", "slowestPath", "stepCount", "serviceCount", "score", "scoreDial", "scoreLabel",
  "pageTimings", "vitalGrid", "requestMix", "criticalCalls", "callFilter", "sortCalls", "callsTable", "openNetworkFilters", "networkFilterCount", "networkFilterChips", "networkFilterDrawer", "closeNetworkFilters", "networkFilterForm", "clearNetworkFilters",
  "callCountBadge", "serviceCountBadge", "insightCountBadge", "savedCountBadge", "callResultCount", "callPageInfo", "previousCallPage", "nextCallPage",
  "journeyDuration", "journeyTimeline", "journeyDetail", "serviceStats", "serviceList", "serviceDetail", "serviceDirectoryNote", "dependencyConfidence",
  "dependencyStats", "criticalChain", "dependencyTree", "narrativeAnalysis", "analysisConfidence", "priorityActions", "insightSummary", "patternList",
  "insightList", "captureName", "captureNote", "saveCapture", "saveStatus", "storageUsage", "savedCaptureList", "compareCaptures", "comparisonView",
  "benchmarkStatus", "benchmarkSummary", "benchmarkTable", "assetSummary", "visibleCode", "recordingDot", "recordingLabel", "sessionStarted",
  "runAudit", "runAuditView", "auditScoreBadge", "securityCountBadge", "auditCoverage", "auditCategoryGrid", "auditFindingList", "auditProfileEditor", "auditBudgetEditor", "saveAuditProfile", "budgetResults", "profileStatus", "overridePattern", "overrideStep", "overrideMetric", "overrideLimit", "addBudgetOverride", "overrideList",
  "securityRisk", "securitySeverity", "securityConfidence", "securityFindingCount", "securityFindingList", "endpointRiskList", "siteAuditStatus", "siteRouteLimit", "discoverRoutes", "startSiteAudit", "cancelSiteAudit", "routeQueueCount", "routeQueue", "routeResults",
  "requestDrawer", "drawerTitle", "drawerContent", "drawerGroupNav", "closeDrawer", "drawerBackdrop", "confirmDialog", "confirmMessage", "confirmDelete"
];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const storageArea = globalThis.chrome?.storage?.local || new MemoryStorageArea();
const store = new SavedCaptureStore(storageArea);
const callbacks = {
  onRequest: handleRawRequest,
  onTelemetry: handleTelemetry,
  onSnapshot: (snapshot) => { state.currentSession.pageSnapshot = snapshot; scheduleRender(); },
  onNavigated: (url) => { recordNavigation(state.currentSession, url); scheduleRender(); }
};
const adapter = devtoolsAvailable
  ? new DevToolsCaptureAdapter(chrome, callbacks)
  : new DemoCaptureAdapter(callbacks, { large: new URL(location.href).searchParams.get("fixture") === "large" });
const auditEngine = new AuditEngine(adapter);
const siteCrawler = new SiteCrawler(adapter);
let apiGroupSequence = 0;

function renderApiReference(label, requestIds, className = "api-reference") {
  const ids = [...new Set((requestIds || []).filter(Boolean))];
  if (!ids.length) return `<span>${escapeHtml(label)}</span>`;
  if (ids.length === 1) return `<button type="button" class="${className}" data-request-id="${ids[0]}">${escapeHtml(label)}</button>`;
  const groupId = `api-group-${++apiGroupSequence}`;
  state.apiGroups.set(groupId, ids);
  return `<button type="button" class="${className}" data-request-group-id="${groupId}">${escapeHtml(label)}</button>`;
}

function findRequest(requestId) {
  return state.currentSession.requests.find((request) => request.id === requestId) || state.savedCaptures.flatMap((capture) => capture.session.requests || []).find((request) => request.id === requestId) || null;
}

function requestIdsForEndpoint(label) {
  const normalized = String(label).replace(/^\w+\s+/, "");
  return [state.currentSession, ...state.savedCaptures.map((capture) => capture.session)].flatMap((session) => session.requests || []).filter((request) => `${request.domain}${request.endpointTemplate}` === normalized || `${request.method} ${request.domain}${request.endpointTemplate}` === label).map((request) => request.id);
}

function handleRawRequest(entry, source, registerHandle) {
  if (!state.recording) return;
  const request = normalizeRequest(entry, state.currentSession.activeStepId);
  const existing = state.currentSession.requests.find((item) => item.dedupeKey === request.dedupeKey);
  if (existing) {
    if (!existing.initiator && request.initiator) existing.initiator = request.initiator;
    registerHandle?.(existing.id);
    return;
  }
  assignRequestByTime(request);
  request.captureSource = source;
  state.currentSession.requests.push(request);
  registerHandle?.(request.id);
  scheduleRender();
}

function assignRequestByTime(request) {
  const timestamp = new Date(request.startedDateTime).getTime();
  const matching = state.currentSession.steps.find((step) => {
    const start = new Date(step.startedAt).getTime();
    const end = step.endedAt ? new Date(step.endedAt).getTime() : Infinity;
    return timestamp >= start && timestamp <= end;
  });
  if (matching) {
    request.stepId = matching.id;
    if (!matching.requestIds.includes(request.id)) matching.requestIds.push(request.id);
  } else {
    assignRequestToStep(state.currentSession, request);
  }
}

function handleTelemetry(sample) {
  mergeTelemetry(state.currentSession, sample);
  associateResourceTimings(state.currentSession);
  els.targetUrl.textContent = sample.url || "Unknown URL";
  scheduleRender();
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    render();
  });
}

function render() {
  const session = state.currentSession;
  const summary = summarize(session);
  const services = summary.services;
  const findings = buildFindings(session);
  const active = getActiveStep(session);
  const descriptor = scoreDescriptor(summary.score);

  els.pageTitle.textContent = session.title || session.pageSnapshot?.title || "Waiting for page";
  if (session.url) els.targetUrl.textContent = session.url;
  els.requestCount.textContent = summary.requestCount;
  els.requestSubtext.textContent = `${summary.errors} failed · ${summary.thirdParty} third-party`;
  els.inpMetric.textContent = formatMs(summary.inp);
  els.longTaskMetric.textContent = `${formatMs(summary.longTaskTime)} long tasks`;
  els.transferSize.textContent = formatBytes(summary.transferSize);
  els.dataPassing.textContent = `${formatBytes(summary.dataPassing)} total data`;
  els.slowestCall.textContent = summary.slowest ? formatMs(summary.slowest.time) : "None";
  els.slowestPath.textContent = summary.slowest ? getPathname(summary.slowest.url) : "Waiting for traffic";
  els.stepCount.textContent = session.steps.length;
  els.serviceCount.textContent = `${services.length} backend services`;
  els.score.textContent = summary.score;
  els.scoreLabel.textContent = descriptor.label;
  els.scoreDial.className = `score-dial ${descriptor.tone === "warn" ? "fair" : descriptor.tone === "bad" ? "poor" : ""}`.trim();
  els.callCountBadge.textContent = summary.requestCount;
  els.serviceCountBadge.textContent = services.length;
  els.insightCountBadge.textContent = findings.filter((finding) => finding.severity !== "low").length;
  els.stepCountBadge.textContent = session.steps.length;
  els.savedCountBadge.textContent = state.savedCaptures.length;
  els.auditScoreBadge.textContent = session.audit?.overallScore ?? "--";
  els.securityCountBadge.textContent = session.audit?.securityFindings?.filter((finding) => ["critical", "high"].includes(finding.severity)).length || 0;
  els.activeStepLabel.textContent = active?.name || "No active step";
  els.stepStatus.textContent = active ? `Recording ${active.kind === "initial" ? "initial load" : "step"}` : "Ready for a named step";
  els.stepStatus.className = `status-pill ${active ? "info" : "neutral"}`;
  els.stopStep.disabled = !active;
  els.sessionStarted.textContent = `Since ${new Date(session.startedAt).toLocaleTimeString()}`;

  const activeView = document.querySelector(".view.active")?.id || "overview";
  renderActiveView(activeView, { summary, services, findings });
}

function renderActiveView(view, derived = {}) {
  const summary = derived.summary || summarize(state.currentSession);
  const services = derived.services || summary.services;
  const findings = derived.findings || buildFindings(state.currentSession);
  if (view === "overview") { renderNarrative(); renderOverview(summary); }
  else if (view === "journeys") renderJourneys();
  else if (view === "calls") renderCalls();
  else if (view === "services") renderServices(services);
  else if (view === "dependencies") renderDependencies();
  else if (view === "audit") renderAudit();
  else if (view === "security") renderSecurity();
  else if (view === "site") renderSiteAudit();
  else if (view === "insights") renderInsights(findings);
  else if (view === "saved") { renderSaved(); renderBenchmarks(); }
  else if (view === "code") renderAssets();
}

function renderNarrative() {
  const narrative = buildNarrative(state.currentSession);
  els.analysisConfidence.textContent = narrative.confidence;
  els.analysisConfidence.className = `status-pill ${narrative.tone}`;
  const auditParagraphs = buildAuditNarrative(state.currentSession);
  els.narrativeAnalysis.innerHTML = [...narrative.paragraphs, ...auditParagraphs].map((paragraph) => `<p>${safeNarrativeHtml(paragraph)}</p>`).join("");
  els.priorityActions.innerHTML = narrative.actions.map((action, index) => `<span class="priority-action"><b>${index + 1}</b>${escapeHtml(action)}</span>`).join("");
}

function renderOverview(summary) {
  const metrics = state.currentSession.pageMetrics || {};
  const telemetry = state.currentSession.telemetry;
  const vitals = [
    ["LCP", telemetry.lcp, formatMs(telemetry.lcp), 2500, 4000],
    ["FCP", telemetry.fcp, formatMs(telemetry.fcp), 1800, 3000],
    ["INP", telemetry.inp, formatMs(telemetry.inp), 200, 500],
    ["CLS", telemetry.cls, Number(telemetry.cls || 0).toFixed(3), 0.1, 0.25]
  ];
  els.vitalGrid.innerHTML = vitals.map(([name, raw, value, good, poor]) => {
    const tone = !raw || raw <= good ? "good" : raw <= poor ? "warn" : "bad";
    return `<article class="vital ${tone}"><span>${name}</span><strong>${escapeHtml(value)}</strong><small>${!raw ? "Not captured" : tone === "good" ? "Good" : tone === "warn" ? "Improve" : "Poor"}</small></article>`;
  }).join("");
  const rows = [
    ["TTFB", formatMs(metrics.ttfb)], ["DOM interactive", formatMs(metrics.domInteractive)], ["DOM complete", formatMs(metrics.domComplete)],
    ["Load event", formatMs(metrics.loadEventEnd)], ["JS heap used", formatBytes(metrics.usedJSHeapSize)], ["Long tasks", state.currentSession.telemetry.longTasks.length]
  ];
  els.pageTimings.innerHTML = rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");

  const grouped = new Map();
  for (const request of state.currentSession.requests) {
    const current = grouped.get(request.type) || { count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += request.transferSize;
    grouped.set(request.type, current);
  }
  const maxBytes = Math.max(1, ...[...grouped.values()].map((item) => item.bytes));
  els.requestMix.innerHTML = grouped.size ? [...grouped.entries()].sort((a, b) => b[1].bytes - a[1].bytes).map(([type, data]) => `<div class="bar-row"><span>${escapeHtml(type)}</span><div class="bar-track"><div class="bar-fill transfer" style="width:${Math.max(2, data.bytes / maxBytes * 100)}%"></div></div><strong>${data.count} · ${formatBytes(data.bytes)}</strong></div>`).join("") : emptyState("No requests captured.");

  const critical = [...state.currentSession.requests].sort((a, b) => (b.time + b.transferSize / 2000 + (b.status >= 400 ? 3000 : 0)) - (a.time + a.transferSize / 2000 + (a.status >= 400 ? 3000 : 0))).slice(0, 6);
  els.criticalCalls.innerHTML = critical.length ? critical.map((request, index) => `<div class="compact-item"><span class="compact-rank">${index + 1}</span><span>${renderApiReference(request.path, [request.id])}<span>${escapeHtml(request.domain)} · ${escapeHtml(request.callKind)}</span></span><span class="compact-metric">${formatMs(request.time)}</span></div>`).join("") : emptyState("No critical calls yet.");
}

function renderJourneys() {
  const session = state.currentSession;
  if (!session.steps.some((step) => step.id === state.selectedStepId)) state.selectedStepId = session.steps[0]?.id || null;
  const elapsed = (session.endedAt ? new Date(session.endedAt) : new Date()) - new Date(session.startedAt);
  els.journeyDuration.textContent = `${formatMs(elapsed)} captured`;
  els.journeyTimeline.innerHTML = session.steps.map((step, index) => {
    const item = summarizeStep(session, step);
    return `<button type="button" class="journey-item ${step.id === state.selectedStepId ? "active" : ""}" data-step-id="${step.id}"><span class="journey-sequence">${String(index + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(step.name)}</strong><span>${item.requestCount} calls · ${formatBytes(item.transferSize)} · ${item.errors} failed</span></span><span class="status-pill ${step.status === "active" ? "info" : item.errors ? "bad" : "good"}">${step.status}</span></button>`;
  }).join("");
  renderJourneyDetail(session.steps.find((step) => step.id === state.selectedStepId));
}

function renderJourneyDetail(step) {
  if (!step) {
    els.journeyDetail.innerHTML = emptyState("Select a journey step.");
    return;
  }
  const item = summarizeStep(state.currentSession, step);
  const events = [
    ...state.currentSession.telemetry.interactions.filter((interaction) => step.interactionIds.includes(interaction.id)).map((interaction) => ({ kind: "Interaction", label: interaction.name, value: formatMs(interaction.duration), id: interaction.id })),
    ...state.currentSession.telemetry.longTasks.filter((task) => step.longTaskIds.includes(task.id)).map((task) => ({ kind: "Long task", label: task.attribution?.join(", ") || task.name, value: formatMs(task.duration), id: task.id })),
    ...item.requests.sort((a, b) => b.time - a.time).slice(0, 8).map((request) => ({ kind: request.callKind, label: `${request.method} ${request.domain}${request.endpointTemplate}`, value: formatMs(request.time), id: request.id, requestId: request.id }))
  ].sort((a, b) => Number.parseFloat(b.value) - Number.parseFloat(a.value));
  els.journeyDetail.innerHTML = `<div class="journey-detail-header"><div><span class="eyebrow">${escapeHtml(step.kind)} step</span><h2>${escapeHtml(step.name)}</h2><p class="muted">${escapeHtml(new Date(step.startedAt).toLocaleString())}${step.endedAt ? ` to ${escapeHtml(new Date(step.endedAt).toLocaleTimeString())}` : " · active"}</p></div><span class="status-pill ${item.errors ? "bad" : "good"}">${item.errors ? `${item.errors} failed` : "No failures"}</span></div>
    <div class="journey-metrics">${miniStats([["Requests", item.requestCount, ""], ["Transferred", formatBytes(item.transferSize), ""], ["Services", item.services, ""], ["Long tasks", item.longTasks, formatMs(item.longTaskTime)], ["Max interaction", formatMs(item.maxInteraction), `${item.interactions} observed`]])}</div>
    <div class="section-heading"><h2>Step evidence</h2><span class="section-note">Slowest first</span></div><div class="journey-events">${events.length ? events.map((event) => `<div class="event-row"><span class="chip info">${escapeHtml(event.kind)}</span><span>${event.requestId ? renderApiReference(event.label, [event.requestId]) : escapeHtml(event.label)}</span><strong>${escapeHtml(event.value)}</strong></div>`).join("") : emptyState("No evidence was attributed to this step.")}</div>`;
}

function getFilteredRequests() {
  const filters = state.networkFilters;
  filters.search = els.callFilter.value.trim();
  const filter = filters.search.toLowerCase();
  const origin = getDomain(state.currentSession.url);
  const riskByRequest = requestRiskMap();
  const requests = state.currentSession.requests.filter((request) => {
    if (filter && ![request.url, request.endpointTemplate, request.domain, request.method, request.status, request.type, request.callKind].some((value) => String(value).toLowerCase().includes(filter))) return false;
    if (filters.steps.length && !filters.steps.includes(request.stepId || "unassigned")) return false;
    if (filters.methods.length && !filters.methods.includes(request.method)) return false;
    if (filters.statuses.length && !filters.statuses.some((status) => status.length === 1 ? Math.floor(request.status / 100) === Number(status) : request.status === Number(status))) return false;
    if (filters.types.length && !filters.types.includes(request.callKind) && !filters.types.includes(request.type)) return false;
    if (filters.domains.length && !filters.domains.includes(request.domain)) return false;
    if (filters.party === "first" && !isSameSite(request.domain, origin)) return false;
    if (filters.party === "third" && isSameSite(request.domain, origin)) return false;
    if (filters.security === "flagged" && !riskByRequest.has(request.id)) return false;
    if (filters.security === "high" && (riskByRequest.get(request.id) || 0) < 40) return false;
    if (filters.cache === "cached" && !request.fromCache) return false;
    if (filters.cache === "uncached" && request.fromCache) return false;
    if (filters.compression === "compressed" && !request.contentEncoding) return false;
    if (filters.compression === "uncompressed" && request.contentEncoding) return false;
    if (filters.body === "present" && !request.hasRequestBody && !request.responseBodyBytes) return false;
    if (filters.body === "absent" && (request.hasRequestBody || request.responseBodyBytes)) return false;
    if (filters.apiStyle === "graphql" && !request.graphql) return false;
    if (filters.apiStyle === "rest" && (request.graphql || !isServiceRequest(request))) return false;
    if (filters.protocols.length && !filters.protocols.includes(request.protocol)) return false;
    if (filters.initiators.length && !filters.initiators.includes(request.initiator?.type || request.resourceTiming?.initiatorType || "unknown")) return false;
    if (filters.confidence.length && !filters.confidence.includes(request.initiator ? "exact" : "inferred")) return false;
    if (filters.durationMin && request.time < filters.durationMin) return false;
    if (filters.durationMax && request.time > filters.durationMax) return false;
    if (filters.transferMin && request.transferSize < filters.transferMin) return false;
    if (filters.transferMax && request.transferSize > filters.transferMax) return false;
    const started = new Date(request.startedDateTime).getTime();
    if (filters.timeStart && started < filters.timeStart) return false;
    if (filters.timeEnd && started > filters.timeEnd) return false;
    return true;
  });
  const sort = els.sortCalls.value;
  requests.sort((a, b) => {
    if (sort === "startedDateTime") return new Date(a.startedDateTime) - new Date(b.startedDateTime);
    if (sort === "domain") return a.domain.localeCompare(b.domain);
    if (sort === "stepId") return String(a.stepId).localeCompare(String(b.stepId));
    if (sort === "securityRisk") return (riskByRequest.get(b.id) || 0) - (riskByRequest.get(a.id) || 0);
    return Number(b[sort] || 0) - Number(a[sort] || 0);
  });
  return requests;
}

function renderCalls() {
  const requests = getFilteredRequests();
  const pages = Math.max(1, Math.ceil(requests.length / PAGE_SIZE));
  state.requestPage = Math.min(state.requestPage, pages);
  const start = (state.requestPage - 1) * PAGE_SIZE;
  const visible = requests.slice(start, start + PAGE_SIZE);
  els.callResultCount.textContent = `${requests.length} results`;
  els.callPageInfo.textContent = `Page ${state.requestPage} of ${pages}`;
  els.previousCallPage.disabled = state.requestPage <= 1;
  els.nextCallPage.disabled = state.requestPage >= pages;
  els.callsTable.innerHTML = visible.length ? visible.map((request) => {
    const step = state.currentSession.steps.find((item) => item.id === request.stepId);
    return `<tr data-request-id="${request.id}" tabindex="0" aria-label="Open ${escapeHtml(request.method)} ${escapeHtml(request.endpointTemplate)}" class="${request.id === state.selectedRequestId ? "selected" : ""}"><td><span class="chip">${escapeHtml(step?.name || "Unassigned")}</span></td><td>${escapeHtml(request.method)}</td><td><span class="chip ${statusTone(request.status)}">${request.status || "pending"}</span></td><td><span class="chip ${isServiceRequest(request) ? "info" : ""}">${escapeHtml(request.callKind)}</span></td><td class="request-cell"><strong title="${escapeHtml(request.url)}">${escapeHtml(request.path)}</strong><span>${escapeHtml(request.domain)} · ${escapeHtml(request.endpointTemplate)}</span></td><td><strong>${formatMs(request.time)}</strong></td><td class="waterfall-cell">${waterfallHtml(request)}</td><td>${formatBytes(request.transferSize)}</td></tr>`;
  }).join("") : `<tr class="empty-row"><td colspan="8">No calls match the current filters.</td></tr>`;
  renderNetworkFilterChips();
}

function requestRiskMap() {
  const map = new Map();
  for (const item of state.currentSession.audit?.endpointRisks || []) for (const id of item.requestIds || []) map.set(id, Math.max(map.get(id) || 0, item.risk));
  return map;
}

function renderNetworkFilterForm() {
  const session = state.currentSession;
  const filters = state.networkFilters;
  const checkboxGroup = (key, values) => `<div class="filter-group full"><label>${escapeHtml(key)}</label><div class="filter-checks">${values.map(([value, label]) => `<label><input type="checkbox" data-filter-array="${key}" value="${escapeHtml(value)}" ${filters[key].includes(value) ? "checked" : ""}>${escapeHtml(label)}</label>`).join("")}</div></div>`;
  const select = (key, label, values) => `<div class="filter-group"><label>${escapeHtml(label)}</label><select data-filter="${key}"><option value="all">All</option>${values.map(([value, text]) => `<option value="${value}" ${filters[key] === value ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></div>`;
  const domains = [...new Set(session.requests.map((request) => request.domain))].sort();
  const protocols = [...new Set(session.requests.map((request) => request.protocol || "unknown"))].sort();
  const types = [...new Set(session.requests.flatMap((request) => [request.callKind, request.type]))].sort();
  els.networkFilterForm.innerHTML = [
    checkboxGroup("steps", [...session.steps.map((step) => [step.id, step.name]), ["unassigned", "Unassigned"]]),
    checkboxGroup("methods", [...new Set(session.requests.map((request) => request.method))].sort().map((value) => [value, value])),
    checkboxGroup("statuses", [["2", "2xx"], ["3", "3xx"], ["4", "4xx"], ["5", "5xx"]]),
    checkboxGroup("types", types.map((value) => [value, value])),
    checkboxGroup("domains", domains.map((value) => [value, value])),
    checkboxGroup("protocols", protocols.map((value) => [value, value])),
    checkboxGroup("initiators", [["parser", "Parser"], ["script", "Script"], ["other", "Other"], ["unknown", "Unknown"]]),
    checkboxGroup("confidence", [["exact", "Exact"], ["inferred", "Inferred"]]),
    select("party", "Party", [["first", "First-party"], ["third", "Third-party"]]),
    select("security", "Security", [["flagged", "Flagged"], ["high", "High risk"]]),
    select("cache", "Cache", [["cached", "Cached"], ["uncached", "Uncached"]]),
    select("compression", "Compression", [["compressed", "Compressed"], ["uncompressed", "Uncompressed"]]),
    select("body", "Body", [["present", "Present"], ["absent", "Absent"]]),
    select("apiStyle", "API style", [["graphql", "GraphQL"], ["rest", "REST / API"]]),
    numericFilter("durationMin", "Min duration (ms)"), numericFilter("durationMax", "Max duration (ms)"),
    numericFilter("transferMin", "Min transfer (bytes)"), numericFilter("transferMax", "Max transfer (bytes)"),
    `<div class="filter-group"><label>Started after</label><input type="datetime-local" data-time-filter="timeStart"></div>`,
    `<div class="filter-group"><label>Started before</label><input type="datetime-local" data-time-filter="timeEnd"></div>`
  ].join("");
}

function numericFilter(key, label) {
  return `<div class="filter-group"><label>${escapeHtml(label)}</label><input type="number" min="0" data-number-filter="${key}" value="${state.networkFilters[key] || ""}"></div>`;
}

function activeNetworkFilters() {
  const filters = state.networkFilters;
  const labels = [];
  for (const key of ["steps", "methods", "statuses", "types", "domains", "protocols", "initiators", "confidence"]) for (const value of filters[key]) labels.push({ key, value, label: `${key}: ${value}` });
  for (const key of ["party", "security", "cache", "compression", "body", "apiStyle"]) if (filters[key] !== "all") labels.push({ key, value: filters[key], label: `${key}: ${filters[key]}` });
  for (const key of ["durationMin", "durationMax", "transferMin", "transferMax", "timeStart", "timeEnd"]) if (filters[key]) labels.push({ key, value: String(filters[key]), label: `${key}: ${filters[key]}` });
  return labels;
}

function renderNetworkFilterChips() {
  const active = activeNetworkFilters();
  els.networkFilterCount.textContent = active.length;
  els.networkFilterChips.innerHTML = active.map((item) => `<button class="filter-chip" type="button" data-remove-filter="${item.key}" data-remove-value="${escapeHtml(item.value)}">${escapeHtml(item.label)} <span aria-hidden="true">×</span></button>`).join("");
}

function renderServices(services) {
  const calls = services.reduce((sum, service) => sum + service.count, 0);
  const external = services.filter((service) => service.thirdParty).length;
  const failures = services.reduce((sum, service) => sum + service.errors, 0);
  const slowest = [...services].sort((a, b) => b.p95 - a.p95)[0];
  els.serviceStats.innerHTML = miniStats([["Service calls", calls, `${services.length} providers`], ["External", external, `${services.length - external} first-party`], ["Failures", failures, failures ? "Review required" : "None"], ["Slowest p95", formatMs(slowest?.p95 || 0), slowest?.domain || "No data"]]);
  if (services.length && !services.some((service) => service.domain === state.selectedServiceDomain)) state.selectedServiceDomain = services[0].domain;
  els.serviceDirectoryNote.textContent = `${services.length} providers`;
  els.serviceList.innerHTML = services.length ? services.map((service) => `<button class="service-item ${service.domain === state.selectedServiceDomain ? "active" : ""}" type="button" data-service-domain="${escapeHtml(service.domain)}"><span class="service-avatar">${escapeHtml(service.domain.slice(0, 2))}</span><span><strong>${escapeHtml(service.domain)}</strong><span>${escapeHtml(service.purpose)} · ${service.endpoints} endpoints</span></span><span class="status-pill ${service.health}">${service.errors ? `${service.errors} failed` : formatMs(service.p95)}</span></button>`).join("") : emptyState("No service calls detected.");
  renderServiceDetail(services.find((service) => service.domain === state.selectedServiceDomain));
}

function renderServiceDetail(service) {
  if (!service) {
    els.serviceDetail.innerHTML = emptyState("Select a service.");
    return;
  }
  const endpointGroups = new Map();
  for (const request of service.requests) {
    const key = `${request.method} ${request.endpointTemplate}`;
    const item = endpointGroups.get(key) || { requests: [], transfer: 0 };
    item.requests.push(request);
    item.transfer += request.transferSize;
    endpointGroups.set(key, item);
  }
  els.serviceDetail.innerHTML = `<div class="service-detail-header"><div><span class="eyebrow">${escapeHtml(service.purpose)}</span><h2>${escapeHtml(service.domain)}</h2><p>${service.thirdParty ? "Third-party" : "First-party"} · ${escapeHtml(service.methods.join(", "))}</p></div><span class="status-pill ${service.health}">${service.errors ? "Errors found" : service.p95 > 1000 ? "Slow" : "Healthy"}</span></div><div class="service-metrics">${miniStats([["Calls", service.count, ""], ["Average", formatMs(service.averageTime), ""], ["P95", formatMs(service.p95), ""], ["Data", formatBytes(service.dataPassing), ""]])}</div><p class="service-assessment">${escapeHtml(service.assessment)}</p><div class="table-wrap service-table-wrap"><table><thead><tr><th>Endpoint</th><th>Calls</th><th>Failures</th><th>P95</th><th>Transfer</th></tr></thead><tbody>${[...endpointGroups.entries()].map(([key, item]) => `<tr><td class="request-cell"><strong>${renderApiReference(key, item.requests.map((request) => request.id))}</strong><span>${item.requests[0].graphql ? `${escapeHtml(item.requests[0].graphql.kind)} ${escapeHtml(item.requests[0].graphql.name)}` : escapeHtml(item.requests[0].callKind)}</span></td><td>${item.requests.length}</td><td>${item.requests.filter((request) => request.status >= 400).length}</td><td>${formatMs(Math.max(...item.requests.map((request) => request.time)))}</td><td>${formatBytes(item.transfer)}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderDependencies() {
  const dependency = buildDependencies(state.currentSession);
  const exact = dependency.edges.filter((edge) => edge.confidence === "exact").length;
  const inferred = dependency.edges.length - exact;
  els.dependencyConfidence.textContent = `${exact} exact · ${inferred} inferred`;
  els.dependencyConfidence.className = `status-pill ${exact ? "good" : inferred ? "warn" : "neutral"}`;
  els.dependencyStats.innerHTML = miniStats([["Edges", dependency.edges.length, ""], ["Exact", exact, "HAR initiators"], ["Inferred", inferred, "Timing proximity"], ["Critical weight", formatMs(dependency.criticalWeight), `${dependency.criticalChain.length} requests`]]);
  els.criticalChain.innerHTML = dependency.criticalChain.length ? dependency.criticalChain.map((request, index) => `<button type="button" class="dependency-item" data-request-id="${request.id}"><span class="journey-sequence">${index + 1}</span><span class="dependency-copy"><strong>${escapeHtml(request.method)} ${escapeHtml(request.domain + request.endpointTemplate)}</strong><span>${escapeHtml(request.initiator?.type || request.resourceTiming?.initiatorType || "inferred")}</span></span><strong>${formatMs(request.time)}</strong></button>`).join("") : emptyState("No dependency chain available.");
  const requests = new Map(state.currentSession.requests.map((request) => [request.id, request]));
  els.dependencyTree.innerHTML = dependency.edges.length ? dependency.edges.slice(0, 200).map((edge) => {
    const from = requests.get(edge.from);
    const to = requests.get(edge.to);
    return `<button type="button" class="dependency-item" data-request-id="${to?.id || ""}"><span class="arrow">-&gt;</span><span class="dependency-copy"><strong>${escapeHtml(from?.endpointTemplate || "root")} to ${escapeHtml(to?.endpointTemplate || "unknown")}</strong><span>${escapeHtml(edge.reason)}</span></span><span class="confidence-${edge.confidence}">${escapeHtml(edge.confidence)}</span></button>`;
  }).join("") : emptyState("Capture initiated requests to build dependencies.");
}

async function runFullAudit() {
  if (state.currentSession.audit?.status === "running") return;
  state.currentSession.audit.status = "running";
  els.runAudit.disabled = true;
  els.runAuditView.disabled = true;
  els.runAudit.textContent = "Auditing...";
  renderAudit();
  try {
    await auditEngine.run(state.currentSession);
  } catch (error) {
    state.currentSession.audit.status = "failed";
    state.currentSession.audit.error = String(error?.message || error);
  } finally {
    els.runAudit.disabled = false;
    els.runAuditView.disabled = false;
    els.runAudit.textContent = "Run full audit";
    render();
  }
}

function renderAudit() {
  const audit = state.currentSession.audit;
  const ready = audit?.status === "complete";
  els.auditCoverage.textContent = ready ? `${audit.overallScore}/100 · ${audit.coverage}% coverage` : audit?.status === "running" ? "Audit running" : audit?.status === "failed" ? "Audit failed" : "Not run";
  els.auditCoverage.className = `status-pill ${ready ? audit.overallScore >= 80 ? "good" : audit.overallScore >= 60 ? "warn" : "bad" : "neutral"}`;
  els.auditCategoryGrid.innerHTML = ready ? audit.categoryScores.map((item) => `<article class="audit-category ${item.status}"><span>${escapeHtml(labelCategory(item.category))}</span><strong>${item.score === null ? "--" : item.score}</strong><small>${item.coverage}% coverage · ${item.findingIds.length} findings</small></article>`).join("") : emptyState("Run the full audit to score performance, delivery, services, reliability, accessibility, SEO, security, and best practices.");
  const findings = [...(audit?.findings || []), ...(audit?.securityFindings || [])].filter((finding) => state.auditSeverity === "all" || (state.auditSeverity === "high" ? ["critical", "high", "serious"].includes(finding.severity) : finding.confidence === state.auditSeverity));
  els.auditFindingList.innerHTML = findings.length ? findings.map((finding) => {
    const requestIds = finding.requestIds || finding.evidenceIds?.filter((id) => state.currentSession.requests.some((request) => request.id === id)) || [];
    const title = renderApiReference(finding.title, requestIds, "api-reference");
    return `<article class="audit-finding"><span class="status-pill ${severityTone(finding.severity)}">${escapeHtml(finding.severity)}</span><div><strong>${title}</strong><p>${escapeHtml(finding.description || finding.evidence || "")}</p><p class="fix-line"><strong>Fix:</strong> ${escapeHtml(finding.fixSuggestion || finding.recommendation || "Review the supporting evidence.")}</p></div></article>`;
  }).join("") : emptyState(ready ? "No findings match this filter." : "Audit evidence will appear here.");
  renderProfileEditor();
  els.budgetResults.innerHTML = (audit?.budgetResults || []).map((item) => `<div class="budget-item ${item.passed ? "" : "failed"}"><span>${escapeHtml(labelCategory(item.key))}</span><strong>${item.passed ? "Pass" : "Over"} · ${escapeHtml(String(item.value))} / ${escapeHtml(String(item.limit))}</strong></div>`).join("");
}

function renderProfileEditor() {
  const profile = state.currentSession.audit?.profile || DEFAULT_AUDIT_PROFILE;
  const weights = profile.weights;
  if (document.querySelector(".profile-panel input:focus, .profile-panel select:focus")) return;
  els.auditProfileEditor.innerHTML = Object.entries(weights).map(([key, value]) => `<label for="weight-${key}">${escapeHtml(labelCategory(key))}</label><input id="weight-${key}" data-profile-weight="${key}" type="number" min="0" max="100" value="${value}">`).join("");
  els.auditBudgetEditor.innerHTML = Object.entries(profile.budgets).map(([key, value]) => `<label for="budget-${key}">${escapeHtml(labelCategory(key))}</label><input id="budget-${key}" data-profile-budget="${key}" type="number" min="0" step="any" value="${value}">`).join("");
  const selectedStep = els.overrideStep.value;
  els.overrideStep.innerHTML = `<option value="">Any journey step</option>${state.currentSession.steps.map((step) => `<option value="${escapeHtml(step.name)}">${escapeHtml(step.name)}</option>`).join("")}`;
  els.overrideStep.value = [...els.overrideStep.options].some((option) => option.value === selectedStep) ? selectedStep : "";
  els.overrideList.innerHTML = profile.overrides?.length ? profile.overrides.map((override, index) => `<div class="budget-item"><span>${escapeHtml(override.routePattern || "Any route")} · ${escapeHtml(override.stepName || "Any step")} · ${escapeHtml(Object.entries(override.budgets).map(([key, value]) => `${key} ≤ ${value}`).join(", "))}</span><button type="button" class="button" data-remove-override="${index}">Remove</button></div>`).join("") : `<p class="muted">No budget overrides.</p>`;
}

function renderSecurity() {
  const audit = state.currentSession.audit;
  const findings = (audit?.securityFindings || []).filter((finding) => (els.securitySeverity.value === "all" || finding.severity === els.securitySeverity.value) && (els.securityConfidence.value === "all" || finding.confidence === els.securityConfidence.value));
  const risk = audit?.securityRisk;
  els.securityRisk.textContent = Number.isFinite(risk) ? `${risk}/100 risk` : "Not audited";
  els.securityRisk.className = `risk-score ${!Number.isFinite(risk) ? "neutral" : risk >= 60 ? "bad" : risk >= 30 ? "warn" : "good"}`;
  els.securityFindingCount.textContent = `${findings.length} of ${audit?.securityFindings?.length || 0} findings`;
  els.endpointRiskList.innerHTML = audit?.endpointRisks?.length ? audit.endpointRisks.map((item) => `<div class="endpoint-risk"><span class="risk-number">${item.risk}</span><div>${renderApiReference(item.endpointKey, item.requestIds)}<span class="muted">${item.findingIds.length} deduplicated checks</span></div><span class="status-pill ${item.risk >= 60 ? "bad" : item.risk >= 30 ? "warn" : "good"}">${item.risk >= 60 ? "High" : item.risk >= 30 ? "Review" : "Low"}</span></div>`).join("") : emptyState("Run a full audit to rank endpoint risk.");
  els.securityFindingList.innerHTML = findings.length ? findings.map((finding) => `<article class="security-finding"><div><span class="status-pill ${severityTone(finding.severity)}">${escapeHtml(finding.severity)}</span><span class="confidence-${escapeHtml(finding.confidence)}">${escapeHtml(finding.confidence)}</span></div><div><strong>${renderApiReference(finding.title, finding.requestIds)}</strong><p>${escapeHtml(finding.description)}</p><p class="fix-line"><strong>Fix:</strong> ${escapeHtml(finding.fixSuggestion)}</p></div></article>`).join("") : emptyState(audit?.status === "complete" ? "No security findings match the selected filters." : "Run a full audit to inspect API and page security signals.");
}

function renderSiteAudit() {
  els.routeQueueCount.textContent = `${state.routeQueue.length} routes`;
  els.routeQueue.innerHTML = state.routeQueue.length ? state.routeQueue.map((url, index) => `<label class="route-item"><input type="checkbox" data-route-index="${index}" checked><span>${escapeHtml(url)}</span></label>`).join("") : emptyState("Discover a sitemap or same-origin links to preview the queue.");
  const run = state.currentSession.siteAudits?.at(-1);
  els.siteAuditStatus.textContent = state.siteAuditRunning ? "Crawling" : run ? `${run.status} · ${run.routes.length} routes` : "Ready";
  els.siteAuditStatus.className = `status-pill ${state.siteAuditRunning ? "info" : run?.status === "complete" ? "good" : run?.status === "failed" ? "bad" : "neutral"}`;
  els.routeResults.innerHTML = run?.routes?.length ? run.routes.map((route) => `<article class="route-result"><span class="route-score">${route.score ?? "--"}</span><div><strong>${escapeHtml(route.title || route.url)}</strong><span class="muted">${escapeHtml(route.url)}</span></div><span class="status-pill ${route.score >= 80 ? "good" : route.score >= 60 ? "warn" : "bad"}">${route.findings.length} findings</span></article>`).join("") : emptyState("Audited routes will appear here.");
}

async function discoverSiteRoutes() {
  els.siteAuditStatus.textContent = "Discovering";
  const links = state.currentSession.audit?.pageSignals?.links || state.currentSession.pageSnapshot?.links || [];
  state.routeQueue = await siteCrawler.discover(state.currentSession.url, links);
  renderSiteAudit();
}

async function startSiteAudit() {
  if (state.siteAuditRunning || !state.routeQueue.length) return;
  state.siteAuditRunning = true;
  els.startSiteAudit.disabled = true;
  els.cancelSiteAudit.disabled = false;
  const selected = [...els.routeQueue.querySelectorAll("[data-route-index]:checked")].map((input) => state.routeQueue[Number(input.dataset.routeIndex)]);
  const originalUrl = state.currentSession.url;
  let routeStartCount = state.currentSession.requests.length;
  const run = await siteCrawler.run(selected, {
    originalUrl,
    limit: Math.min(100, Math.max(1, Number(els.siteRouteLimit.value) || 25)),
    onProgress: ({ index, total, url }) => { routeStartCount = state.currentSession.requests.length; els.siteAuditStatus.textContent = `${index + 1}/${total} · ${getPathname(url)}`; },
    onRoute: async (url) => {
      const routeSession = structuredClone(state.currentSession);
      routeSession.url = url;
      routeSession.requests = routeSession.requests.slice(routeStartCount);
      routeSession.audit = structuredClone(state.currentSession.audit);
      await auditEngine.run(routeSession);
      return { url, title: routeSession.audit.pageSignals?.title || routeSession.title, score: routeSession.audit.overallScore, categoryScores: routeSession.audit.categoryScores, findings: routeSession.audit.findings, securityFindings: routeSession.audit.securityFindings, metrics: { lcp: routeSession.telemetry.lcp, inp: routeSession.telemetry.inp, transferSize: routeSession.requests.reduce((sum, request) => sum + request.transferSize, 0) } };
    }
  });
  state.currentSession.siteAudits.push(run);
  state.siteAuditRunning = false;
  els.startSiteAudit.disabled = false;
  els.cancelSiteAudit.disabled = true;
  renderSiteAudit();
}

function severityTone(severity) { return ["critical", "high", "serious"].includes(severity) ? "bad" : ["medium", "moderate"].includes(severity) ? "warn" : "info"; }
function labelCategory(value) { return String(value).replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()); }

function renderInsights(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  findings.forEach((finding) => { counts[finding.severity] += 1; });
  els.insightSummary.innerHTML = [[counts.high, "Critical"], [counts.medium, "Important"], [counts.low, "Advisory"]].map(([count, label]) => `<article class="finding-count"><strong>${count}</strong><span>${label}</span></article>`).join("");
  const patterns = detectPatterns(state.currentSession);
  els.patternList.innerHTML = patterns.length ? patterns.map((pattern) => `<article class="pattern-item ${pattern.severity}"><span class="eyebrow">${escapeHtml(pattern.type)}</span><h3>${renderApiReference(pattern.title, pattern.requestIds)}</h3><p>${escapeHtml(pattern.detail)}</p></article>`).join("") : emptyState("No repeated request patterns detected.");
  els.insightList.innerHTML = findings.length ? findings.map((finding) => `<article class="insight ${finding.severity}"><span class="status-pill ${finding.severity === "high" ? "bad" : finding.severity === "medium" ? "warn" : "info"}">${finding.severity}</span><div class="insight-title"><strong>${renderApiReference(finding.title, finding.evidenceIds)}</strong><span>${escapeHtml(finding.category)}</span><p>${escapeHtml(finding.evidence)}</p></div><div class="insight-detail"><strong>Recommended action</strong><span>${escapeHtml(finding.recommendation)}</span></div></article>`).join("") : emptyState("No findings yet.");
}

async function renderSaved() {
  els.savedCountBadge.textContent = state.savedCaptures.length;
  const usage = await store.usage();
  els.storageUsage.textContent = `${formatBytes(usage.bytes)} of ${formatBytes(usage.quota)}`;
  els.savedCaptureList.innerHTML = state.savedCaptures.length ? state.savedCaptures.map((capture) => {
    const summary = summarize(capture.session);
    return `<article class="saved-item"><input type="checkbox" aria-label="Select ${escapeHtml(capture.name)} for comparison" data-compare-id="${capture.id}" ${state.compareSelection.has(capture.id) ? "checked" : ""}><div class="saved-copy"><input data-rename-id="${capture.id}" value="${escapeHtml(capture.name)}" aria-label="Capture name"><span>${escapeHtml(capture.note || "No note")} · ${escapeHtml(new Date(capture.savedAt).toLocaleString())}</span><span>${summary.score}/100 · ${summary.requestCount} calls · ${formatBytes(summary.transferSize)}</span></div><div class="saved-actions"><button class="button" type="button" data-action="rename" data-capture-id="${capture.id}">Update</button><button class="button" type="button" data-action="delete" data-capture-id="${capture.id}">Delete</button></div></article>`;
  }).join("") : emptyState("No captures saved locally.");
  renderComparison();
}

function renderComparison() {
  if (!state.comparison) {
    els.comparisonView.innerHTML = emptyState("Choose two saved captures.");
    return;
  }
  els.comparisonView.className = "";
  els.comparisonView.innerHTML = `<table class="comparison-table"><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>${state.comparison.metrics.map((metric) => `<tr><td>${escapeHtml(metric.label)}</td><td>${formatComparisonValue(metric.key, metric.before)}</td><td>${formatComparisonValue(metric.key, metric.after)}</td><td class="${metric.improved ? "improved" : metric.delta ? "regressed" : ""}">${metric.delta > 0 ? "+" : ""}${metric.delta.toFixed(1)} · ${metric.percent.toFixed(1)}%</td></tr>`).join("")}</tbody></table><div class="section-heading"><h2>Endpoint changes</h2></div><div class="two-column"><div><strong>Added</strong>${state.comparison.addedEndpoints.length ? `<ul>${state.comparison.addedEndpoints.map((endpoint) => `<li>${renderApiReference(endpoint, requestIdsForEndpoint(endpoint))}</li>`).join("")}</ul>` : `<p class="muted">None</p>`}</div><div><strong>Removed</strong>${state.comparison.removedEndpoints.length ? `<ul>${state.comparison.removedEndpoints.map((endpoint) => `<li>${renderApiReference(endpoint, requestIdsForEndpoint(endpoint))}</li>`).join("")}</ul>` : `<p class="muted">None</p>`}</div></div>`;
}

function formatComparisonValue(key, value) {
  if (["transferSize"].includes(key)) return formatBytes(value);
  if (["serviceP95", "inp", "longTaskTime"].includes(key)) return formatMs(value);
  return escapeHtml(Number(value).toFixed(key === "score" || key === "requestCount" || key === "errors" ? 0 : 1));
}

function renderBenchmarks() {
  els.benchmarkTable.innerHTML = state.benchmarkRuns.length ? state.benchmarkRuns.map((run, index) => {
    const summary = summarize(run);
    return `<tr><td>${index + 1}</td><td>${summary.requestCount}</td><td>${formatMs(summary.totalTime)}</td><td>${formatBytes(summary.transferSize)}</td><td>${formatMs(run.pageMetrics.loadEventEnd)}</td><td>${formatMs(run.telemetry.lcp)}</td><td>${summary.score}</td></tr>`;
  }).join("") : `<tr class="empty-row"><td colspan="7">No benchmark runs.</td></tr>`;
  if (!state.benchmarkRuns.length) {
    els.benchmarkSummary.innerHTML = "";
    return;
  }
  const scores = state.benchmarkRuns.map((run) => summarize(run).score).sort((a, b) => a - b);
  const loads = state.benchmarkRuns.map((run) => run.pageMetrics.loadEventEnd || 0).sort((a, b) => a - b);
  els.benchmarkSummary.innerHTML = miniStats([["Median score", scores[Math.floor(scores.length / 2)], ""], ["Median load", formatMs(loads[Math.floor(loads.length / 2)]), ""], ["Fastest", formatMs(Math.min(...loads)), ""], ["Slowest", formatMs(Math.max(...loads)), ""]]);
}

function renderAssets() {
  const snapshot = state.currentSession.pageSnapshot;
  if (!snapshot) {
    els.assetSummary.innerHTML = `<dt>Snapshot</dt><dd>Not captured</dd>`;
    els.visibleCode.textContent = "No snapshot captured.";
    return;
  }
  const rows = [["DOM nodes", snapshot.domNodes], ["Scripts", snapshot.scripts.length], ["Stylesheets", snapshot.stylesheets.length], ["Images", snapshot.images.length], ["Missing alt", snapshot.imagesMissingAlt], ["Forms", snapshot.forms.length], ["Links", snapshot.linkCount], ["Detected stack", snapshot.frameworkHints.join(", ") || "Unknown"]];
  els.assetSummary.innerHTML = rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  els.visibleCode.textContent = [`URL: ${snapshot.url}`, `Title: ${snapshot.title}`, `Stack: ${snapshot.frameworkHints.join(", ") || "unknown"}`, "", "Scripts:", ...snapshot.scripts.slice(0, 40).map((item) => `- ${item || "[inline]"}`), "", "Stylesheets:", ...snapshot.stylesheets.slice(0, 40).map((item) => `- ${item || "[inline]"}`), "", "Visible text:", snapshot.visibleText].join("\n");
}

async function openRequestGroup(requestIds, startIndex = 0) {
  const valid = [...new Set(requestIds)].filter((id) => findRequest(id));
  if (!valid.length) return;
  state.inspectorGroup = valid;
  state.inspectorIndex = Math.max(0, Math.min(startIndex, valid.length - 1));
  await openRequestDrawer(valid[state.inspectorIndex], true);
}

async function openRequestDrawer(requestId, preserveGroup = false) {
  const request = findRequest(requestId);
  if (!request) return;
  if (!preserveGroup) { state.inspectorGroup = [requestId]; state.inspectorIndex = 0; }
  state.selectedRequestId = requestId;
  els.drawerTitle.textContent = `${request.method} ${request.endpointTemplate}`;
  const groupCount = state.inspectorGroup.length;
  els.drawerGroupNav.hidden = groupCount <= 1;
  els.drawerGroupNav.innerHTML = groupCount > 1 ? `<button type="button" class="button" data-inspector-nav="previous" ${state.inspectorIndex === 0 ? "disabled" : ""}>Previous</button><span>${state.inspectorIndex + 1} of ${groupCount} supporting requests</span><button type="button" class="button" data-inspector-nav="next" ${state.inspectorIndex >= groupCount - 1 ? "disabled" : ""}>Next</button>` : "";
  const step = state.currentSession.steps.find((item) => item.id === request.stepId);
  const relatedSecurity = state.currentSession.audit?.securityFindings?.filter((finding) => finding.requestIds?.includes(request.id)) || [];
  els.drawerContent.innerHTML = `<div class="drawer-url">${escapeHtml(request.url)}</div><div class="drawer-metrics">${miniStats([["Status", `${request.status} ${request.statusText}`, ""], ["Duration", formatMs(request.time), ""], ["Transferred", formatBytes(request.transferSize), ""], ["Payload", formatBytes(request.requestPayloadBytes), ""]])}</div><dl class="metric-list"><dt>Journey step</dt><dd>${escapeHtml(step?.name || "Unassigned")}</dd><dt>Endpoint template</dt><dd>${escapeHtml(request.endpointTemplate)}</dd><dt>Initiator</dt><dd>${escapeHtml(request.initiator?.type || request.resourceTiming?.initiatorType || "unknown")}</dd><dt>Protocol / priority</dt><dd>${escapeHtml(request.protocol || "unknown")} · ${escapeHtml(request.priority || "unknown")}</dd><dt>Server address</dt><dd>${escapeHtml(request.serverIPAddress || "not exposed")}</dd><dt>Cache</dt><dd>${escapeHtml(request.fromCache ? "Cache hit" : request.cacheControl || "No policy exposed")}</dd><dt>GraphQL</dt><dd>${request.graphql ? `${escapeHtml(request.graphql.kind)} ${escapeHtml(request.graphql.name)}` : "Not detected"}</dd></dl>${relatedSecurity.length ? `<section class="drawer-section"><h3>Security evidence</h3>${relatedSecurity.map((finding) => `<div class="security-finding"><span class="status-pill ${severityTone(finding.severity)}">${escapeHtml(finding.severity)}</span><div><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.description)}</p></div></div>`).join("")}</section>` : ""}<section class="drawer-section"><h3>Timing phases</h3>${renderTimingDetails(request)}</section><section class="drawer-section"><h3>Query parameters</h3>${renderHeaders(request.queryParams)}</section><section class="drawer-section"><h3>Request headers</h3>${renderHeaders(request.requestHeaders)}</section><section class="drawer-section"><h3>Response headers</h3>${renderHeaders(request.responseHeaders)}</section><section class="drawer-section"><h3>Request body</h3><div id="requestBody" class="body-loading">Loading redacted preview...</div></section><section class="drawer-section"><div class="section-heading"><h3>Response body</h3><button type="button" class="button" data-audit-body="${request.id}">Audit response shape</button></div><div id="bodyAuditResult"></div><div id="responseBody" class="body-loading">Loading redacted preview...</div></section>`;
  els.requestDrawer.classList.add("open");
  els.requestDrawer.setAttribute("aria-hidden", "false");
  els.drawerBackdrop.hidden = false;
  renderCalls();
  const preview = state.bodyPreviews.get(requestId) || await adapter.loadBodies(requestId);
  state.bodyPreviews.set(requestId, preview);
  const requestBody = document.getElementById("requestBody");
  const responseBody = document.getElementById("responseBody");
  if (requestBody) requestBody.outerHTML = `<pre id="requestBody" class="payload-block">${escapeHtml(preview.request)}</pre>`;
  if (responseBody) responseBody.outerHTML = `<pre id="responseBody" class="payload-block">${escapeHtml(preview.response)}</pre>`;
}

function renderHeaders(headers = []) {
  return headers.length ? `<dl class="header-table">${headers.map((header) => `<dt>${escapeHtml(header.name)}</dt><dd>${escapeHtml(header.value)}</dd>`).join("")}</dl>` : `<p class="muted">No values available.</p>`;
}

function renderTimingDetails(request) {
  const phases = [["Blocked", request.timings.blocked], ["DNS", request.timings.dns], ["Connect", request.timings.connect], ["SSL", request.timings.ssl], ["Send", request.timings.send], ["Wait / TTFB", request.timings.wait], ["Receive", request.timings.receive]].filter(([, value]) => Number.isFinite(value) && value >= 0);
  const max = Math.max(1, ...phases.map(([, value]) => value));
  return `<div class="timing-detail">${phases.map(([label, value], index) => `<div class="timing-row"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="${index < 4 ? "timing-connect" : index === 6 ? "timing-receive" : "timing-wait"}" style="width:${Math.max(1, value / max * 100)}%;height:100%"></div></div><span>${formatMs(value)}</span></div>`).join("")}</div>`;
}

function closeRequestDrawer() {
  state.selectedRequestId = null;
  els.requestDrawer.classList.remove("open");
  els.requestDrawer.setAttribute("aria-hidden", "true");
  els.drawerBackdrop.hidden = true;
  state.inspectorGroup = [];
  renderCalls();
}

function closeNetworkFilters() {
  els.networkFilterDrawer.classList.remove("open");
  els.networkFilterDrawer.setAttribute("aria-hidden", "true");
  if (!els.requestDrawer.classList.contains("open")) els.drawerBackdrop.hidden = true;
}

function resetSession(label = "Live capture") {
  state.currentSession = createSession(label);
  state.selectedStepId = state.currentSession.steps[0].id;
  state.selectedServiceDomain = null;
  state.bodyPreviews.clear();
  state.requestPage = 1;
  state.networkFilters = emptyNetworkFilters();
  state.routeQueue = [];
  closeRequestDrawer();
  render();
}

async function runBenchmark() {
  if (!devtoolsAvailable || state.benchmarking) return;
  const count = Math.max(2, Math.min(10, Number(els.benchmarkRuns.value) || 3));
  state.benchmarking = true;
  state.benchmarkRuns = [];
  els.runBenchmark.disabled = true;
  for (let index = 0; index < count; index += 1) {
    resetSession(`Benchmark ${index + 1}`);
    els.benchmarkStatus.textContent = `Running ${index + 1} of ${count}`;
    adapter.reload();
    await waitForNetworkQuiet();
    adapter.sampleTelemetry?.();
    await new Promise((resolve) => setTimeout(resolve, 700));
    state.currentSession.endedAt = new Date().toISOString();
    state.benchmarkRuns.push(serializableSession(state.currentSession));
    renderBenchmarks();
  }
  state.benchmarking = false;
  els.runBenchmark.disabled = false;
  els.benchmarkStatus.textContent = `Completed ${count} runs`;
  resetSession("Live capture after benchmark");
}

function waitForNetworkQuiet() {
  return new Promise((resolve) => {
    const started = Date.now();
    let last = -1;
    let stable = 0;
    const timer = setInterval(() => {
      const current = state.currentSession.requests.length;
      stable = current === last ? stable + 1 : 0;
      last = current;
      if (stable >= 3 || Date.now() - started > 18000) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

async function saveCurrentCapture() {
  try {
    const saved = await store.save(state.currentSession, { name: els.captureName.value, note: els.captureNote.value });
    state.savedCaptures.push(saved);
    els.captureName.value = "";
    els.captureNote.value = "";
    els.saveStatus.textContent = "Saved locally";
    await renderSaved();
  } catch (error) {
    els.saveStatus.textContent = error.message;
  }
}

function exportReport() {
  const selected = [...state.compareSelection].map((id) => state.savedCaptures.find((capture) => capture.id === id)).filter(Boolean);
  const report = buildReportHtml(state.currentSession, { comparisonCaptures: selected.length === 2 ? selected : [], visibleCode: els.visibleCode.textContent });
  const blob = new Blob([report], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `puffy-v0.4-${new Date().toISOString().replaceAll(":", "-")}.html`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  els.exportReport.textContent = "Report ready";
  setTimeout(() => { URL.revokeObjectURL(url); els.exportReport.textContent = "Export report"; }, 1500);
}

function activateView(view) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === view));
  renderActiveView(view);
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => activateView(tab.dataset.view)));
els.toggleRecording.addEventListener("click", () => { state.recording = !state.recording; updateRecordingUi(); });
els.clearSession.addEventListener("click", () => resetSession());
els.reloadCapture.addEventListener("click", () => { resetSession("Reload capture"); adapter.reload(); });
els.runBenchmark.addEventListener("click", runBenchmark);
els.runAudit.addEventListener("click", runFullAudit);
els.runAuditView.addEventListener("click", runFullAudit);
els.exportReport.addEventListener("click", exportReport);
els.startStep.addEventListener("click", () => {
  const name = els.stepName.value.trim();
  if (!name) { els.stepName.focus(); return; }
  const step = startJourneyStep(state.currentSession, name);
  state.selectedStepId = step.id;
  els.stepName.value = "";
  render();
});
els.stopStep.addEventListener("click", () => { stopActiveStep(state.currentSession); render(); });
els.journeyTimeline.addEventListener("click", (event) => { const item = event.target.closest("[data-step-id]"); if (item) { state.selectedStepId = item.dataset.stepId; renderJourneys(); } });
els.serviceList.addEventListener("click", (event) => { const item = event.target.closest("[data-service-domain]"); if (item) { state.selectedServiceDomain = item.dataset.serviceDomain; renderServices(analyzeServices(state.currentSession)); } });
for (const element of [els.callFilter, els.sortCalls]) element.addEventListener(element.tagName === "INPUT" ? "input" : "change", () => { state.requestPage = 1; renderCalls(); });
els.previousCallPage.addEventListener("click", () => { state.requestPage = Math.max(1, state.requestPage - 1); renderCalls(); });
els.nextCallPage.addEventListener("click", () => { state.requestPage += 1; renderCalls(); });
els.closeDrawer.addEventListener("click", closeRequestDrawer);
els.drawerBackdrop.addEventListener("click", () => { closeRequestDrawer(); closeNetworkFilters(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { closeRequestDrawer(); closeNetworkFilters(); }
  if (["Enter", " "].includes(event.key) && event.target.matches("tr[data-request-id]")) { event.preventDefault(); openRequestDrawer(event.target.dataset.requestId); }
});
document.addEventListener("click", async (event) => {
  const group = event.target.closest("[data-request-group-id]");
  if (group) { event.preventDefault(); return openRequestGroup(state.apiGroups.get(group.dataset.requestGroupId) || []); }
  const request = event.target.closest("[data-request-id]");
  if (request?.dataset.requestId) { event.preventDefault(); return openRequestDrawer(request.dataset.requestId); }
  const navigation = event.target.closest("[data-inspector-nav]");
  if (navigation) {
    state.inspectorIndex += navigation.dataset.inspectorNav === "next" ? 1 : -1;
    return openRequestDrawer(state.inspectorGroup[state.inspectorIndex], true);
  }
  const bodyAudit = event.target.closest("[data-audit-body]");
  if (bodyAudit) {
    bodyAudit.disabled = true;
    bodyAudit.textContent = "Auditing...";
    const requestRecord = state.currentSession.requests.find((item) => item.id === bodyAudit.dataset.auditBody);
    const preview = state.bodyPreviews.get(requestRecord.id) || await adapter.loadBodies(requestRecord.id);
    const result = auditBodyPreview(requestRecord, preview);
    state.currentSession.audit.bodyAudits = [...(state.currentSession.audit.bodyAudits || []).filter((item) => item.requestId !== result.requestId), result];
    await auditEngine.run(state.currentSession);
    const target = document.getElementById("bodyAuditResult");
    if (target) target.innerHTML = result.findings.length ? result.findings.map((finding) => `<p class="fix-line"><strong>${escapeHtml(finding.title)}:</strong> ${escapeHtml(finding.fixSuggestion)}</p>`).join("") : `<p class="muted">No selected response-shape heuristic was triggered.</p>`;
    bodyAudit.textContent = "Audit complete";
    render();
  }
});

els.openNetworkFilters.addEventListener("click", () => { renderNetworkFilterForm(); els.networkFilterDrawer.classList.add("open"); els.networkFilterDrawer.setAttribute("aria-hidden", "false"); els.drawerBackdrop.hidden = false; });
els.closeNetworkFilters.addEventListener("click", closeNetworkFilters);
els.clearNetworkFilters.addEventListener("click", () => { state.networkFilters = emptyNetworkFilters(); els.callFilter.value = ""; state.requestPage = 1; renderNetworkFilterForm(); renderCalls(); });
els.networkFilterForm.addEventListener("change", (event) => {
  const array = event.target.dataset.filterArray;
  if (array) state.networkFilters[array] = [...els.networkFilterForm.querySelectorAll(`[data-filter-array="${array}"]:checked`)].map((input) => input.value);
  if (event.target.dataset.filter) state.networkFilters[event.target.dataset.filter] = event.target.value;
  if (event.target.dataset.numberFilter) state.networkFilters[event.target.dataset.numberFilter] = Math.max(0, Number(event.target.value) || 0);
  if (event.target.dataset.timeFilter) state.networkFilters[event.target.dataset.timeFilter] = event.target.value ? new Date(event.target.value).getTime() : 0;
  state.requestPage = 1;
  renderCalls();
});
els.networkFilterChips.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-remove-filter]");
  if (!chip) return;
  const key = chip.dataset.removeFilter;
  if (Array.isArray(state.networkFilters[key])) state.networkFilters[key] = state.networkFilters[key].filter((value) => value !== chip.dataset.removeValue);
  else state.networkFilters[key] = ["party", "security", "cache", "compression", "body", "apiStyle"].includes(key) ? "all" : 0;
  state.requestPage = 1;
  renderCalls();
});

document.querySelectorAll("[data-audit-severity]").forEach((button) => button.addEventListener("click", () => { state.auditSeverity = button.dataset.auditSeverity; document.querySelectorAll("[data-audit-severity]").forEach((item) => item.classList.toggle("active", item === button)); renderAudit(); }));
els.securitySeverity.addEventListener("change", renderSecurity);
els.securityConfidence.addEventListener("change", renderSecurity);
els.saveAuditProfile.addEventListener("click", async () => {
  const weights = Object.fromEntries([...els.auditProfileEditor.querySelectorAll("[data-profile-weight]")].map((input) => [input.dataset.profileWeight, Number(input.value)]));
  const budgets = Object.fromEntries([...els.auditBudgetEditor.querySelectorAll("[data-profile-budget]")].map((input) => [input.dataset.profileBudget, Number(input.value)]));
  const profile = { ...state.currentSession.audit.profile, weights, budgets };
  if (!validateAuditProfile(profile)) { els.profileStatus.textContent = "Weights must be non-negative and total 100."; return; }
  state.currentSession.audit.profile = profile;
  els.profileStatus.textContent = "Profile applied.";
  if (state.currentSession.audit.status === "complete") await runFullAudit();
});
els.addBudgetOverride.addEventListener("click", () => {
  const limit = Number(els.overrideLimit.value);
  if (!Number.isFinite(limit) || limit < 0 || (!els.overridePattern.value.trim() && !els.overrideStep.value)) { els.profileStatus.textContent = "Provide a route glob or journey step and a non-negative limit."; return; }
  state.currentSession.audit.profile.overrides.push({ routePattern: els.overridePattern.value.trim(), stepName: els.overrideStep.value, budgets: { [els.overrideMetric.value]: limit } });
  els.overridePattern.value = "";
  els.overrideLimit.value = "";
  els.profileStatus.textContent = "Budget override added. Apply the profile to rescore.";
  renderProfileEditor();
});
els.overrideList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-override]");
  if (!button) return;
  state.currentSession.audit.profile.overrides.splice(Number(button.dataset.removeOverride), 1);
  renderProfileEditor();
});
els.discoverRoutes.addEventListener("click", discoverSiteRoutes);
els.startSiteAudit.addEventListener("click", startSiteAudit);
els.cancelSiteAudit.addEventListener("click", () => siteCrawler.cancel());
els.saveCapture.addEventListener("click", saveCurrentCapture);
els.savedCaptureList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-compare-id]");
  if (!checkbox) return;
  if (checkbox.checked) {
    if (state.compareSelection.size >= 2) { checkbox.checked = false; return; }
    state.compareSelection.add(checkbox.dataset.compareId);
  } else state.compareSelection.delete(checkbox.dataset.compareId);
});
els.savedCaptureList.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const id = action.dataset.captureId;
  if (action.dataset.action === "rename") {
    const input = els.savedCaptureList.querySelector(`[data-rename-id="${CSS.escape(id)}"]`);
    await store.rename(id, input.value);
    state.savedCaptures = await store.list();
    await renderSaved();
  } else {
    state.pendingDeleteId = id;
    const capture = state.savedCaptures.find((item) => item.id === id);
    els.confirmMessage.textContent = `Delete ${capture?.name || "this capture"}? This cannot be undone.`;
    els.confirmDialog.showModal();
  }
});
els.confirmDialog.addEventListener("close", async () => {
  if (els.confirmDialog.returnValue !== "confirm" || !state.pendingDeleteId) { state.pendingDeleteId = null; return; }
  await store.remove(state.pendingDeleteId);
  state.compareSelection.delete(state.pendingDeleteId);
  state.pendingDeleteId = null;
  state.savedCaptures = await store.list();
  state.comparison = null;
  await renderSaved();
});
els.compareCaptures.addEventListener("click", () => {
  const captures = [...state.compareSelection].map((id) => state.savedCaptures.find((capture) => capture.id === id)).filter(Boolean);
  state.comparison = captures.length === 2 ? compareCaptures(captures[0], captures[1]) : null;
  renderComparison();
});

function updateRecordingUi() {
  els.toggleRecording.textContent = state.recording ? "Pause" : "Resume";
  els.toggleRecording.classList.toggle("paused", !state.recording);
  els.recordingDot.classList.toggle("paused", !state.recording);
  els.recordingLabel.textContent = devtoolsAvailable ? state.recording ? "Capturing live" : "Capture paused" : "Preview mode";
}

async function initialize() {
  state.savedCaptures = await store.list();
  if (!devtoolsAvailable) {
    const previewStart = new Date(Date.now() - 6000).toISOString();
    state.currentSession.startedAt = previewStart;
    state.currentSession.steps[0].startedAt = previewStart;
    els.reloadCapture.disabled = true;
    els.runBenchmark.disabled = true;
    els.toggleRecording.disabled = true;
  }
  updateRecordingUi();
  await adapter.start();
  render();
}

initialize();
