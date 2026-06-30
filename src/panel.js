import { analyzeServices, associateResourceTimings, buildDependencies, buildFindings, buildNarrative, compareCaptures, detectPatterns, isServiceRequest, normalizeRequest, summarize, summarizeStep } from "./core/analysis.js";
import { DemoCaptureAdapter, DevToolsCaptureAdapter } from "./core/capture.js";
import { AuditEngine, buildAuditNarrative } from "./core/audit.js";
import { SiteCrawler } from "./core/crawler.js";
import { DEFAULT_AUDIT_PROFILE, assignRequestToStep, createSession, getActiveStep, mergeTelemetry, recordNavigation, serializableSession, startStep as startJourneyStep, stopActiveStep } from "./core/model.js";
import { MemoryStorageArea, SavedCaptureStore, isExtensionContextInvalidatedError } from "./core/persistence.js";
import { emptyState, escapeHtml, formatBytes, formatMs, miniStats, safeNarrativeHtml, scoreDescriptor, statusTone, waterfallHtml } from "./core/render.js";
import { buildReportHtml } from "./core/report.js";
import { auditBodyPreview } from "./core/security.js";
import { validateAuditProfile } from "./core/scoring.js";
import { getDomain, getPathname, isSameSite } from "./core/utils.js";
import { buildCurlCommand, parseBody } from "./core/inspector.js";
import { summarizeWebSockets } from "./core/websocket.js";
import { DEFAULT_VISUALIZATION_PREFERENCES, buildJourneyTimeline, buildNetworkSeries, buildSiteGraph } from "./core/visualization.js";
import { renderJourneyTimeline, renderNetworkOverview, renderSiteConstellation, renderSparkline } from "./ui/visualizations.js";
import { bodyViewerHtml, graphqlViewerHtml, webSocketMessageHtml } from "./ui/body-viewer.js";

const devtoolsAvailable = Boolean(globalThis.chrome?.devtools?.network && globalThis.chrome?.devtools?.inspectedWindow);
const PAGE_SIZE = 100;

function emptyNetworkFilters() {
  return { search: "", steps: [], methods: [], statuses: [], types: [], domains: [], party: "all", security: "all", cache: "all", compression: "all", body: "all", apiStyle: "all", protocols: [], initiators: [], confidence: [], durationMin: 0, durationMax: 0, transferMin: 0, transferMax: 0, timeStart: 0, timeEnd: 0 };
}

function loadVisualizationPreferences() {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    const stored = JSON.parse(localStorage.getItem("puffy.visualizationPreferences.v1") || "null");
    return { ...DEFAULT_VISUALIZATION_PREFERENCES, motionEnabled: !reducedMotion, ...stored, ...(reducedMotion ? { motionEnabled: false } : {}) };
  } catch {
    return { ...DEFAULT_VISUALIZATION_PREFERENCES, motionEnabled: !reducedMotion };
  }
}

function saveVisualizationPreferences() {
  localStorage.setItem("puffy.visualizationPreferences.v1", JSON.stringify(state.visualization));
}

const state = {
  theme: localStorage.getItem("puffy.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
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
  bodyViewModes: new Map(),
  webSockets: { version: 1, installedAt: 0, observedAt: 0, connections: [] },
  selectedWebSocketId: null,
  selectedWebSocketMessageId: null,
  webSocketDirection: "all",
  webSocketSearch: "",
  requestPage: 1,
  networkFilters: emptyNetworkFilters(),
  apiGroups: new Map(),
  inspectorGroup: [],
  inspectorIndex: 0,
  auditSeverity: "all",
  routeQueue: [],
  siteAuditRunning: false,
  liveSiteRun: null,
  activeRouteUrl: "",
  selectedRouteId: null,
  siteMode: "map",
  journeyProgress: 0,
  journeyPlaying: false,
  timelineStepId: null,
  selectedVital: "LCP",
  visualization: loadVisualizationPreferences(),
  renderQueued: false,
  pendingDeleteId: null
};
state.selectedStepId = state.currentSession.steps[0].id;

const ids = [
  "targetUrl", "pageTitle", "themeToggle", "toggleRecording", "clearSession", "reloadCapture", "benchmarkRuns", "runBenchmark", "exportReport",
  "stepName", "startStep", "stopStep", "activeStepLabel", "stepStatus", "stepCountBadge", "requestCount", "requestSubtext", "inpMetric",
  "longTaskMetric", "transferSize", "dataPassing", "slowestCall", "slowestPath", "stepCount", "serviceCount", "score", "scoreDial", "scoreLabel",
  "pageTimings", "vitalGrid", "vitalAttribution", "benchmarkSparkline", "requestMix", "criticalCalls", "callFilter", "sortCalls", "callsTable", "openNetworkFilters", "networkFilterCount", "networkFilterChips", "networkFilterDrawer", "closeNetworkFilters", "networkFilterForm", "clearNetworkFilters", "networkOverview", "networkRangeLabel",
  "callCountBadge", "webSocketCountBadge", "serviceCountBadge", "insightCountBadge", "savedCountBadge", "callResultCount", "callPageInfo", "previousCallPage", "nextCallPage",
  "journeyDuration", "journeyTimeline", "journeyDetail", "journeyVisualization", "journeyPlaybackTime", "journeyPlay", "journeyScrubber", "serviceStats", "serviceList", "serviceDetail", "serviceDirectoryNote", "dependencyConfidence",
  "dependencyStats", "criticalChain", "dependencyTree", "narrativeAnalysis", "analysisConfidence", "priorityActions", "insightSummary", "patternList",
  "insightList", "captureName", "captureNote", "saveCapture", "saveStatus", "storageUsage", "savedCaptureList", "compareCaptures", "comparisonView",
  "benchmarkStatus", "benchmarkSummary", "benchmarkTable", "assetSummary", "visibleCode", "recordingDot", "recordingLabel", "sessionStarted",
  "runAudit", "runAuditView", "auditScoreBadge", "securityCountBadge", "auditCoverage", "auditCategoryGrid", "auditFindingList", "auditProfileEditor", "auditBudgetEditor", "saveAuditProfile", "budgetResults", "profileStatus", "overridePattern", "overrideStep", "overrideMetric", "overrideLimit", "addBudgetOverride", "overrideList",
  "securityRisk", "securitySeverity", "securityConfidence", "securityFindingCount", "securityFindingList", "endpointRiskList", "siteAuditStatus", "siteRouteLimit", "discoverRoutes", "startSiteAudit", "cancelSiteAudit", "siteGraphSearch", "siteGraphLayout", "siteNodeMetric", "toggleMotion", "resetSiteGraph", "siteGraphPanel", "siteListPanel", "siteGraph", "siteGraphLegend", "routeQueueCount", "routeQueue", "routeResults", "routeDetail",
  "webSocketLiveStatus", "webSocketStats", "webSocketSearch", "webSocketDirection", "webSocketConnectionList", "webSocketMessages", "webSocketDetail",
  "requestDrawer", "drawerTitle", "drawerContent", "drawerGroupNav", "closeDrawer", "drawerBackdrop", "confirmDialog", "confirmMessage", "confirmDelete"
];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
document.documentElement.dataset.theme = state.theme;
state.visualization.theme = state.theme;

const storageArea = globalThis.chrome?.storage?.local || new MemoryStorageArea();
const store = new SavedCaptureStore(storageArea);
const callbacks = {
  onRequest: handleRawRequest,
  onTelemetry: handleTelemetry,
  onSnapshot: (snapshot) => { state.currentSession.pageSnapshot = snapshot; scheduleRender(); },
  onNavigated: (url) => { recordNavigation(state.currentSession, url); scheduleRender(); },
  onWebSockets: (snapshot) => { state.webSockets = snapshot; scheduleRender(); },
  onContextInvalidated: handlePanelError
};
const adapter = devtoolsAvailable
  ? new DevToolsCaptureAdapter(chrome, callbacks)
  : new DemoCaptureAdapter(callbacks, { large: new URL(location.href).searchParams.get("fixture") === "large" });
const auditEngine = new AuditEngine(adapter);
const siteCrawler = new SiteCrawler(adapter);
let apiGroupSequence = 0;
let siteGraphController = null;
let journeyTimelineController = null;
let networkOverviewController = null;
let journeyAnimationFrame = 0;
const metricAnimations = new WeakMap();
let contextInvalidated = false;

function handlePanelError(error) {
  if (isExtensionContextInvalidatedError(error)) {
    showContextInvalidated();
    return;
  }
  console.error("Puffy operation failed", error);
  showToast(error?.message || "The operation failed.");
}

function showContextInvalidated() {
  if (contextInvalidated) return;
  contextInvalidated = true;
  pauseJourneyPlayback();
  siteGraphController?.destroy();
  try { adapter.stop?.(); } catch {}
  document.querySelectorAll(".workspace button, .workspace input, .workspace select").forEach((control) => { control.disabled = true; });
  const banner = document.createElement("section");
  banner.className = "context-invalidated-banner";
  banner.setAttribute("role", "alert");
  banner.innerHTML = `<div><strong>Extension reloaded</strong><span>This DevTools panel is using an expired Chrome extension context.</span></div><button type="button" class="button button-primary">Reload panel</button>`;
  banner.querySelector("button").addEventListener("click", () => location.reload());
  document.body.append(banner);
}

function setAnimatedNumber(element, value, formatter = (number) => Math.round(number)) {
  const target = Number(value || 0);
  const previous = Number(element.dataset.metricValue ?? target);
  element.dataset.metricValue = String(target);
  metricAnimations.get(element)?.cancel?.();
  if (!state.visualization.motionEnabled || previous === target || document.hidden) {
    element.textContent = formatter(target);
    return;
  }
  const started = performance.now();
  let cancelled = false;
  metricAnimations.set(element, { cancel: () => { cancelled = true; } });
  const tick = (now) => {
    if (cancelled) return;
    const progress = Math.min(1, (now - started) / 360);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = formatter(previous + (target - previous) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setButtonContent(button, icon, label) {
  button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#${icon}"></use></svg><span>${escapeHtml(label)}</span>`;
}

function applyTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  state.visualization.theme = state.theme;
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("puffy.theme", state.theme);
  saveVisualizationPreferences();
  const next = state.theme === "dark" ? "light" : "dark";
  els.themeToggle.innerHTML = `<svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#${state.theme === "dark" ? "sun" : "moon"}"></use></svg>`;
  els.themeToggle.setAttribute("aria-label", `Use ${next} theme`);
  els.themeToggle.title = `Use ${next} theme`;
}

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
  setAnimatedNumber(els.requestCount, summary.requestCount);
  els.requestSubtext.textContent = `${summary.errors} failed · ${summary.thirdParty} third-party`;
  els.inpMetric.textContent = formatMs(summary.inp);
  els.longTaskMetric.textContent = `${formatMs(summary.longTaskTime)} long tasks`;
  els.transferSize.textContent = formatBytes(summary.transferSize);
  els.dataPassing.textContent = `${formatBytes(summary.dataPassing)} total data`;
  els.slowestCall.textContent = summary.slowest ? formatMs(summary.slowest.time) : "None";
  els.slowestPath.textContent = summary.slowest ? getPathname(summary.slowest.url) : "Waiting for traffic";
  els.stepCount.textContent = session.steps.length;
  els.serviceCount.textContent = `${services.length} backend services`;
  setAnimatedNumber(els.score, summary.score);
  els.scoreLabel.textContent = descriptor.label;
  els.scoreDial.className = `score-dial ${descriptor.tone === "warn" ? "fair" : descriptor.tone === "bad" ? "poor" : ""}`.trim();
  els.scoreDial.style.setProperty("--score-progress", `${summary.score * 3.6}deg`);
  els.callCountBadge.textContent = summary.requestCount;
  els.webSocketCountBadge.textContent = summarizeWebSockets(state.webSockets).messages;
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
  if (view !== "site") { siteGraphController?.destroy(); siteGraphController = null; }
  if (view !== "journeys") { pauseJourneyPlayback(); journeyTimelineController?.destroy(); journeyTimelineController = null; }
  if (view !== "calls") { networkOverviewController?.destroy(); networkOverviewController = null; }
  const summary = derived.summary || summarize(state.currentSession);
  const services = derived.services || summary.services;
  const findings = derived.findings || buildFindings(state.currentSession);
  if (view === "overview") { renderNarrative(); renderOverview(summary); }
  else if (view === "journeys") renderJourneys();
  else if (view === "calls") renderCalls();
  else if (view === "websockets") renderWebSockets();
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
    return `<button type="button" class="vital ${tone} ${state.selectedVital === name ? "selected" : ""}" data-vital-name="${name}"><span>${name}</span><strong>${escapeHtml(value)}</strong><small>${!raw ? "Not captured" : tone === "good" ? "Good" : tone === "warn" ? "Improve" : "Poor"}</small></button>`;
  }).join("");
  renderVitalAttribution();
  const rows = [
    ["TTFB", formatMs(metrics.ttfb)], ["DOM interactive", formatMs(metrics.domInteractive)], ["DOM complete", formatMs(metrics.domComplete)],
    ["Load event", formatMs(metrics.loadEventEnd)], ["JS heap used", formatBytes(metrics.usedJSHeapSize)], ["Long tasks", state.currentSession.telemetry.longTasks.length]
  ];
  els.pageTimings.innerHTML = rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  renderSparkline(els.benchmarkSparkline, state.benchmarkRuns.map((run) => summarize(run).score));

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

function renderVitalAttribution() {
  const name = state.selectedVital;
  const telemetry = state.currentSession.telemetry || {};
  const attribution = state.currentSession.audit?.pageSignals?.vitalsAttribution?.[name.toLowerCase()] || state.currentSession.audit?.pageSignals?.vitalsAttribution?.[name] || null;
  const fallback = name === "INP" ? `${telemetry.interactions?.length || 0} interactions observed; slowest ${formatMs(Math.max(0, ...(telemetry.interactions || []).map((item) => item.duration || 0)))}`
    : name === "LCP" ? `Latest contentful paint at ${formatMs(telemetry.lcp || 0)}`
      : name === "CLS" ? `${Number(telemetry.cls || 0).toFixed(3)} cumulative layout shift` : `First contentful paint at ${formatMs(telemetry.fcp || 0)}`;
  const detail = attribution && typeof attribution === "object" ? Object.entries(attribution).slice(0, 4).map(([key, value]) => `${labelCategory(key)}: ${String(value)}`).join(" · ") : fallback;
  els.vitalAttribution.innerHTML = `<span class="eyebrow">${escapeHtml(name)} attribution</span><p>${escapeHtml(detail)}</p>`;
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
  const selectedStep = session.steps.find((step) => step.id === state.selectedStepId);
  if (state.timelineStepId !== selectedStep?.id) {
    state.timelineStepId = selectedStep?.id || null;
    state.journeyProgress = 0;
    pauseJourneyPlayback();
  }
  const timeline = buildJourneyTimeline(session, selectedStep);
  journeyTimelineController?.destroy();
  journeyTimelineController = renderJourneyTimeline(els.journeyVisualization, timeline, {
    progress: state.journeyProgress,
    onRequest: (requestId) => openRequestDrawer(requestId)
  });
  els.journeyScrubber.value = Math.round(state.journeyProgress * 1000);
  els.journeyPlaybackTime.textContent = `${formatMs(timeline.duration * state.journeyProgress)} of ${formatMs(timeline.duration)}`;
  updateJourneyPlayButton();
  renderJourneyDetail(selectedStep);
}

function updateJourneyProgress(progress) {
  state.journeyProgress = Math.max(0, Math.min(1, progress));
  els.journeyScrubber.value = Math.round(state.journeyProgress * 1000);
  const step = state.currentSession.steps.find((item) => item.id === state.selectedStepId);
  const timeline = buildJourneyTimeline(state.currentSession, step);
  journeyTimelineController?.setProgress(state.journeyProgress);
  els.journeyPlaybackTime.textContent = `${formatMs(timeline.duration * state.journeyProgress)} of ${formatMs(timeline.duration)}`;
}

function startJourneyPlayback() {
  if (state.journeyPlaying) return pauseJourneyPlayback();
  if (state.journeyProgress >= 1) updateJourneyProgress(0);
  state.journeyPlaying = true;
  updateJourneyPlayButton();
  let previous = performance.now();
  const tick = (now) => {
    if (!state.journeyPlaying || document.hidden || !document.getElementById("journeys").classList.contains("active")) return pauseJourneyPlayback();
    const step = state.currentSession.steps.find((item) => item.id === state.selectedStepId);
    const duration = Math.max(1, buildJourneyTimeline(state.currentSession, step).duration);
    updateJourneyProgress(state.journeyProgress + ((now - previous) * state.visualization.timelineSpeed) / duration);
    previous = now;
    if (state.journeyProgress >= 1) return pauseJourneyPlayback();
    journeyAnimationFrame = requestAnimationFrame(tick);
  };
  journeyAnimationFrame = requestAnimationFrame(tick);
}

function pauseJourneyPlayback() {
  state.journeyPlaying = false;
  cancelAnimationFrame(journeyAnimationFrame);
  journeyAnimationFrame = 0;
  updateJourneyPlayButton();
}

function updateJourneyPlayButton() {
  if (!els.journeyPlay) return;
  const playing = state.journeyPlaying;
  els.journeyPlay.innerHTML = `<svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#${playing ? "pause" : "play"}"></use></svg>`;
  els.journeyPlay.setAttribute("aria-label", playing ? "Pause timeline" : "Play timeline");
  els.journeyPlay.title = playing ? "Pause timeline" : "Play timeline";
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
  networkOverviewController?.destroy();
  const series = buildNetworkSeries(state.currentSession.requests);
  networkOverviewController = renderNetworkOverview(els.networkOverview, series, {
    selection: state.networkFilters,
    onBrush: (range) => {
      state.networkFilters.timeStart = range?.timeStart || 0;
      state.networkFilters.timeEnd = range?.timeEnd || 0;
      state.requestPage = 1;
      renderCalls();
    }
  });
  els.networkRangeLabel.textContent = state.networkFilters.timeStart && state.networkFilters.timeEnd
    ? `${new Date(state.networkFilters.timeStart).toLocaleTimeString()} to ${new Date(state.networkFilters.timeEnd).toLocaleTimeString()}` : "Full capture";
  renderNetworkFilterChips();
}

function renderWebSockets() {
  const snapshot = state.webSockets;
  const summary = summarizeWebSockets(snapshot);
  const connections = snapshot.connections || [];
  if (!connections.some((connection) => connection.id === state.selectedWebSocketId)) state.selectedWebSocketId = connections[0]?.id || null;
  const selected = connections.find((connection) => connection.id === state.selectedWebSocketId);
  const search = state.webSocketSearch.trim().toLowerCase();
  const matchingConnections = connections.filter((connection) => !search || connection.url.toLowerCase().includes(search) || connection.messages.some((message) => message.preview.toLowerCase().includes(search)));
  const visibleMessages = (selected?.messages || []).filter((message) => (state.webSocketDirection === "all" || message.direction === state.webSocketDirection) && (!search || message.preview.toLowerCase().includes(search) || selected.url.toLowerCase().includes(search)));
  if (!visibleMessages.some((message) => message.id === state.selectedWebSocketMessageId)) state.selectedWebSocketMessageId = visibleMessages.at(-1)?.id || null;
  const selectedMessage = visibleMessages.find((message) => message.id === state.selectedWebSocketMessageId);

  els.webSocketLiveStatus.textContent = snapshot.installedAt ? `Observing since ${new Date(snapshot.installedAt).toLocaleTimeString()}` : "Waiting for instrumentation";
  els.webSocketLiveStatus.className = `status-pill ${summary.open ? "good" : snapshot.installedAt ? "neutral" : "warn"}`;
  els.webSocketStats.innerHTML = miniStats([
    ["Connections", summary.connections, `${summary.open} open`],
    ["Frames", summary.messages, `${connections.reduce((sum, connection) => sum + connection.messages.filter((message) => message.direction === "incoming").length, 0)} incoming`],
    ["Sent", formatBytes(summary.sentBytes), "transient"],
    ["Received", formatBytes(summary.receivedBytes), "transient"]
  ]);
  els.webSocketConnectionList.innerHTML = matchingConnections.length ? matchingConnections.map((connection) => `<button type="button" class="websocket-connection ${connection.id === state.selectedWebSocketId ? "active" : ""}" data-websocket-id="${escapeHtml(connection.id)}"><span class="socket-state ${escapeHtml(connection.state)}" aria-hidden="true"></span><span><strong>${escapeHtml(webSocketLabel(connection.url))}</strong><small>${escapeHtml(connection.url)}</small><span>${connection.messages.length} frames · ${formatBytes(connection.sentBytes + connection.receivedBytes)}</span></span><span class="status-pill ${connection.state === "open" ? "good" : connection.state === "error" ? "bad" : "neutral"}">${escapeHtml(connection.state)}</span></button>`).join("") : emptyState(search ? "No sockets match this filter." : "No WebSocket connections observed. Reconnect a socket while Puffy is open.");
  els.webSocketMessages.innerHTML = selected ? `<div class="websocket-stream-header"><strong>${escapeHtml(webSocketLabel(selected.url))}</strong><span>${escapeHtml(selected.protocol || selected.protocols?.join(", ") || "No subprotocol")}</span></div>${visibleMessages.length ? visibleMessages.map((message) => {
    const parsed = parseBody(message.preview);
    const frameType = parsed.kind === "json" && parsed.value?.type ? parsed.value.type : parsed.kind;
    return `<button type="button" class="websocket-message ${message.direction} ${message.id === state.selectedWebSocketMessageId ? "active" : ""}" data-websocket-message-id="${escapeHtml(message.id)}"><svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#arrow-${message.direction === "outgoing" ? "up" : "down"}"></use></svg><span><strong>${escapeHtml(frameType)}</strong><small>${escapeHtml(message.preview.replace(/\s+/g, " ").slice(0, 150) || `[${message.type}]`)}</small></span><span><time>${escapeHtml(new Date(message.at).toLocaleTimeString())}</time><small>${formatBytes(message.bytes)}</small></span></button>`;
  }).join("") : emptyState("No message frames match the current filters.")}` : emptyState("Select a WebSocket connection.");
  els.webSocketDetail.innerHTML = webSocketMessageHtml(selectedMessage);
}

function webSocketLabel(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return value || "Unknown socket";
  }
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
  for (const key of ["durationMin", "durationMax", "transferMin", "transferMax", "timeStart", "timeEnd"]) {
    if (!filters[key]) continue;
    const label = key === "timeStart" ? `started after ${new Date(filters[key]).toLocaleTimeString()}` : key === "timeEnd" ? `started before ${new Date(filters[key]).toLocaleTimeString()}` : `${labelCategory(key)}: ${filters[key]}`;
    labels.push({ key, value: String(filters[key]), label });
  }
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
  setButtonContent(els.runAudit, "loader-circle", "Auditing");
  renderAudit();
  try {
    await auditEngine.run(state.currentSession);
  } catch (error) {
    state.currentSession.audit.status = "failed";
    state.currentSession.audit.error = String(error?.message || error);
  } finally {
    els.runAudit.disabled = false;
    els.runAuditView.disabled = false;
    setButtonContent(els.runAudit, "scan-search", "Run audit");
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
  const run = state.liveSiteRun || state.currentSession.siteAudits?.at(-1);
  els.siteAuditStatus.textContent = state.siteAuditRunning ? "Crawling" : run ? `${run.status} · ${run.routes.length} routes` : "Ready";
  els.siteAuditStatus.className = `status-pill ${state.siteAuditRunning ? "info" : run?.status === "complete" ? "good" : run?.status === "failed" ? "bad" : "neutral"}`;
  const graph = buildSiteGraph(state.routeQueue, run, state.currentSession.url || run?.originalUrl || "", state.activeRouteUrl);
  if (!graph.nodes.some((node) => node.id === state.selectedRouteId)) state.selectedRouteId = graph.rootId || graph.nodes[0]?.id || null;
  els.siteGraphLayout.value = state.visualization.siteLayout;
  els.siteNodeMetric.value = state.visualization.siteMetric;
  els.toggleMotion.classList.toggle("active", state.visualization.motionEnabled);
  els.toggleMotion.setAttribute("aria-label", state.visualization.motionEnabled ? "Disable visualization motion" : "Enable visualization motion");
  els.siteGraphPanel.hidden = state.siteMode !== "map";
  els.siteListPanel.hidden = state.siteMode !== "list";
  document.querySelectorAll("[data-site-mode]").forEach((button) => button.classList.toggle("active", button.dataset.siteMode === state.siteMode));
  const listNodes = graph.nodes.filter((node) => node.kind === "route" && (!els.siteGraphSearch.value || `${node.url} ${node.label}`.toLowerCase().includes(els.siteGraphSearch.value.toLowerCase())));
  els.routeResults.innerHTML = listNodes.length ? listNodes.map((node) => `<button type="button" class="route-result ${node.id === state.selectedRouteId ? "selected" : ""}" data-site-node-id="${node.id}"><span class="route-score">${node.score ?? "--"}</span><div><strong>${escapeHtml(node.label)}</strong><span class="muted">${escapeHtml(node.url)}</span></div><span class="status-pill ${node.state === "failed" ? "bad" : node.state === "scanning" ? "info" : node.score == null ? "neutral" : node.score >= 80 ? "good" : node.score >= 60 ? "warn" : "bad"}">${escapeHtml(node.state)} · ${node.findings.length} findings</span></button>`).join("") : emptyState("No discovered pages match this view.");
  siteGraphController?.destroy();
  siteGraphController = state.siteMode === "map" ? renderSiteConstellation(els.siteGraph, graph, {
    selectedId: state.selectedRouteId,
    search: els.siteGraphSearch.value,
    layout: state.visualization.siteLayout,
    metric: state.visualization.siteMetric,
    motionEnabled: state.visualization.motionEnabled,
    onSelect: (id) => selectSiteRoute(graph, id),
    onNavigate: (id) => { selectSiteRoute(graph, id); siteGraphController?.focusNode(id); }
  }) : null;
  els.siteGraphLegend.innerHTML = `<span><i class="legend-node site"></i>Site root</span><span><i class="legend-node good"></i>Score 80+</span><span><i class="legend-node warn"></i>Score 60-79</span><span><i class="legend-node bad"></i>Score below 60</span><span><i class="legend-node queued"></i>Queued</span><span><i class="legend-line"></i>Path parent</span>`;
  selectSiteRoute(graph, state.selectedRouteId);
}

function selectSiteRoute(graph, id) {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) {
    els.routeDetail.innerHTML = emptyState("Select a route node or list row.");
    return;
  }
  state.selectedRouteId = id;
  els.siteGraph.querySelectorAll("[data-node-id]").forEach((element) => element.classList.toggle("selected", element.dataset.nodeId === id));
  els.routeResults.querySelectorAll("[data-site-node-id]").forEach((element) => element.classList.toggle("selected", element.dataset.siteNodeId === id));
  if (node.kind === "site") {
    const routes = graph.nodes.filter((item) => item.kind === "route");
    const audited = routes.filter((item) => item.state === "complete").length;
    const direct = routes.filter((item) => item.parentId === node.id).length;
    els.routeDetail.className = "route-detail";
    els.routeDetail.innerHTML = `<div class="route-detail-header"><div><span class="eyebrow">Topology root</span><h2>${escapeHtml(node.label)}</h2><p>${escapeHtml(node.url)}</p></div><span class="status-pill info">Site map</span></div><div class="journey-metrics">${miniStats([["Pages", routes.length, "discovered"], ["Direct children", direct, "path roots"], ["Audited", audited, `${Math.max(0, routes.length - audited)} queued`], ["Connections", graph.edges.length, "path-parent edges"]])}</div><p class="service-assessment">This root groups discovered pages for topology only. It is not presented as an audited page unless the homepage itself appears in the route list.</p>`;
    return;
  }
  const metrics = [["Score", node.score ?? "--", ""], ["Transfer", formatBytes(node.metrics.transferSize || 0), ""], ["LCP", formatMs(node.metrics.lcp || 0), ""], ["Findings", node.findings.length, node.state]];
  const categories = node.score == null ? "" : `<div class="route-category-grid">${(node.categoryScores || []).map((item) => `<div><span>${escapeHtml(labelCategory(item.category))}</span><strong>${item.score ?? "--"}</strong></div>`).join("")}</div>`;
  const findings = node.findings.length ? node.findings.map((finding) => {
    const ids = finding.requestIds || finding.evidenceIds?.filter((requestId) => state.currentSession.requests.some((request) => request.id === requestId)) || [];
    return `<article class="route-finding"><span class="status-pill ${severityTone(finding.severity)}">${escapeHtml(finding.severity || "review")}</span><div><strong>${renderApiReference(finding.title || "Route finding", ids)}</strong><p>${escapeHtml(finding.description || finding.evidence || "Supporting evidence retained for this route.")}</p></div></article>`;
  }).join("") : emptyState(node.state === "complete" ? "No retained findings for this route." : "Audit this route to collect evidence.");
  els.routeDetail.className = "route-detail";
  els.routeDetail.innerHTML = `<div class="route-detail-header"><div><span class="eyebrow">${escapeHtml(node.state)} route</span><h2>${escapeHtml(node.title || node.label)}</h2><p>${escapeHtml(node.url)}</p></div><span class="status-pill ${node.score == null ? "neutral" : node.score >= 80 ? "good" : node.score >= 60 ? "warn" : "bad"}">${node.score == null ? "Not scored" : `${node.score}/100`}</span></div><div class="journey-metrics">${miniStats(metrics)}</div>${categories}<div class="section-heading"><h3>Top evidence</h3><span class="section-note">${node.findings.length} retained</span></div><div class="route-finding-list">${findings}</div>`;
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
    onProgress: ({ index, total, url, run: liveRun }) => {
      routeStartCount = state.currentSession.requests.length;
      state.activeRouteUrl = url;
      state.liveSiteRun = liveRun;
      els.siteAuditStatus.textContent = `${index + 1}/${total} · ${getPathname(url)}`;
      renderSiteAudit();
    },
    onRouteComplete: ({ run: liveRun }) => { state.liveSiteRun = liveRun; renderSiteAudit(); },
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
  state.activeRouteUrl = "";
  state.liveSiteRun = null;
  els.startSiteAudit.disabled = false;
  els.cancelSiteAudit.disabled = true;
  renderSiteAudit();
  showToast(run.status === "complete" ? `Site audit complete: ${run.routes.length} routes` : `Site audit ${run.status}`);
}

function showToast(message) {
  let toast = document.getElementById("appToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "appToast";
    toast.className = "app-toast";
    toast.setAttribute("role", "status");
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 1800);
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
  els.drawerContent.innerHTML = `<div class="drawer-actionbar"><button type="button" class="button button-primary" data-copy-curl="${request.id}"><svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#terminal"></use></svg><span>Copy as cURL</span></button><button type="button" class="button" data-copy-request-url="${request.id}"><svg class="icon" aria-hidden="true"><use href="vendor/lucide.svg#link"></use></svg><span>Copy URL</span></button></div><div class="drawer-url">${escapeHtml(request.url)}</div><div class="drawer-metrics">${miniStats([["Status", `${request.status} ${request.statusText}`, ""], ["Duration", formatMs(request.time), ""], ["Transferred", formatBytes(request.transferSize), ""], ["Payload", formatBytes(request.requestPayloadBytes), ""]])}</div><dl class="metric-list"><dt>Journey step</dt><dd>${escapeHtml(step?.name || "Unassigned")}</dd><dt>Endpoint template</dt><dd>${escapeHtml(request.endpointTemplate)}</dd><dt>Initiator</dt><dd>${escapeHtml(request.initiator?.type || request.resourceTiming?.initiatorType || "unknown")}</dd><dt>Protocol / priority</dt><dd>${escapeHtml(request.protocol || "unknown")} · ${escapeHtml(request.priority || "unknown")}</dd><dt>Server address</dt><dd>${escapeHtml(request.serverIPAddress || "not exposed")}</dd><dt>Cache</dt><dd>${escapeHtml(request.fromCache ? "Cache hit" : request.cacheControl || "No policy exposed")}</dd><dt>GraphQL</dt><dd>${request.graphql ? `${escapeHtml(request.graphql.kind)} ${escapeHtml(request.graphql.name)}` : "Not detected"}</dd></dl>${relatedSecurity.length ? `<section class="drawer-section"><h3>Security evidence</h3>${relatedSecurity.map((finding) => `<div class="security-finding"><span class="status-pill ${severityTone(finding.severity)}">${escapeHtml(finding.severity)}</span><div><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.description)}</p></div></div>`).join("")}</section>` : ""}<section class="drawer-section"><h3>Timing phases</h3>${renderTimingDetails(request)}</section><section class="drawer-section"><h3>Query parameters</h3>${renderHeaders(request.queryParams)}</section><section class="drawer-section"><h3>Request headers</h3>${renderHeaders(request.requestHeaders)}</section><section class="drawer-section"><h3>Response headers</h3>${renderHeaders(request.responseHeaders)}</section><div id="graphqlInspector"></div><section class="drawer-section"><h3>Request body</h3><div id="requestBody" class="body-loading">Loading redacted preview...</div></section><section class="drawer-section"><div class="section-heading"><h3>Response body</h3><button type="button" class="button" data-audit-body="${request.id}">Audit response shape</button></div><div id="bodyAuditResult"></div><div id="responseBody" class="body-loading">Loading redacted preview...</div></section>`;
  els.requestDrawer.classList.add("open");
  els.requestDrawer.setAttribute("aria-hidden", "false");
  els.drawerBackdrop.hidden = false;
  renderCalls();
  const preview = state.bodyPreviews.get(requestId) || await adapter.loadBodies(requestId);
  state.bodyPreviews.set(requestId, preview);
  renderInspectorBodies(request, preview);
}

function renderInspectorBodies(request, preview) {
  const requestBody = document.getElementById("requestBody");
  const responseBody = document.getElementById("responseBody");
  const requestMode = state.bodyViewModes.get(`${request.id}:request`) || "tree";
  const responseMode = state.bodyViewModes.get(`${request.id}:response`) || "tree";
  if (requestBody) requestBody.innerHTML = bodyViewerHtml(preview.request, { side: "request", requestId: request.id, mode: requestMode });
  if (responseBody) responseBody.innerHTML = bodyViewerHtml(preview.response, { side: "response", requestId: request.id, mode: responseMode });
  const graphql = document.getElementById("graphqlInspector");
  if (graphql) graphql.innerHTML = request.graphql ? graphqlViewerHtml(request, preview.request, preview.response) : "";
}

function renderHeaders(headers = []) {
  return headers.length ? `<dl class="header-table">${headers.map((header) => `<dt>${escapeHtml(header.name)}</dt><dd>${escapeHtml(header.value)}</dd>`).join("")}</dl>` : `<p class="muted">No values available.</p>`;
}

function renderTimingDetails(request) {
  const phases = [["Blocked", request.timings.blocked], ["DNS", request.timings.dns], ["Connect", request.timings.connect], ["SSL", request.timings.ssl], ["Send", request.timings.send], ["Wait / TTFB", request.timings.wait], ["Receive", request.timings.receive]].filter(([, value]) => Number.isFinite(value) && value >= 0);
  const max = Math.max(1, ...phases.map(([, value]) => value));
  return `<div class="timing-detail">${phases.map(([label, value], index) => `<div class="timing-row"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="${index < 4 ? "timing-connect" : index === 6 ? "timing-receive" : "timing-wait"}" style="width:${Math.max(1, value / max * 100)}%;height:100%"></div></div><span>${formatMs(value)}</span></div>`).join("")}</div>`;
}

async function copyInspectorText(text, label) {
  const value = String(text || "");
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast(`${label} copied`);
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
  state.bodyViewModes.clear();
  state.requestPage = 1;
  state.networkFilters = emptyNetworkFilters();
  state.routeQueue = [];
  state.activeRouteUrl = "";
  state.liveSiteRun = null;
  state.selectedRouteId = null;
  state.journeyProgress = 0;
  state.timelineStepId = null;
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
    if (isExtensionContextInvalidatedError(error)) handlePanelError(error);
  }
}

function exportReport() {
  const selected = [...state.compareSelection].map((id) => state.savedCaptures.find((capture) => capture.id === id)).filter(Boolean);
  const report = buildReportHtml(state.currentSession, { comparisonCaptures: selected.length === 2 ? selected : [], visibleCode: els.visibleCode.textContent });
  const blob = new Blob([report], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `puffy-v0.5-${new Date().toISOString().replaceAll(":", "-")}.html`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setButtonContent(els.exportReport, "check", "Report ready");
  setTimeout(() => { URL.revokeObjectURL(url); setButtonContent(els.exportReport, "download", "Export"); }, 1500);
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
els.themeToggle.addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
els.runAudit.addEventListener("click", runFullAudit);
els.runAuditView.addEventListener("click", runFullAudit);
els.exportReport.addEventListener("click", exportReport);
els.vitalGrid.addEventListener("click", (event) => {
  const vital = event.target.closest("[data-vital-name]");
  if (!vital) return;
  state.selectedVital = vital.dataset.vitalName;
  renderOverview(summarize(state.currentSession));
});
els.startStep.addEventListener("click", () => {
  const name = els.stepName.value.trim();
  if (!name) { els.stepName.focus(); return; }
  const step = startJourneyStep(state.currentSession, name);
  state.selectedStepId = step.id;
  els.stepName.value = "";
  render();
});
els.stopStep.addEventListener("click", () => { stopActiveStep(state.currentSession); render(); });
els.journeyTimeline.addEventListener("click", (event) => { const item = event.target.closest("[data-step-id]"); if (item) { state.selectedStepId = item.dataset.stepId; state.journeyProgress = 0; renderJourneys(); } });
els.journeyPlay.addEventListener("click", startJourneyPlayback);
els.journeyScrubber.addEventListener("input", () => { pauseJourneyPlayback(); updateJourneyProgress(Number(els.journeyScrubber.value) / 1000); });
document.querySelectorAll("[data-timeline-speed]").forEach((button) => button.addEventListener("click", () => {
  state.visualization.timelineSpeed = Number(button.dataset.timelineSpeed) === 2 ? 2 : 1;
  document.querySelectorAll("[data-timeline-speed]").forEach((item) => item.classList.toggle("active", item === button));
  saveVisualizationPreferences();
}));
els.serviceList.addEventListener("click", (event) => { const item = event.target.closest("[data-service-domain]"); if (item) { state.selectedServiceDomain = item.dataset.serviceDomain; renderServices(analyzeServices(state.currentSession)); } });
for (const element of [els.callFilter, els.sortCalls]) element.addEventListener(element.tagName === "INPUT" ? "input" : "change", () => { state.requestPage = 1; renderCalls(); });
els.webSocketSearch.addEventListener("input", () => { state.webSocketSearch = els.webSocketSearch.value; renderWebSockets(); });
els.webSocketDirection.addEventListener("change", () => { state.webSocketDirection = els.webSocketDirection.value; renderWebSockets(); });
els.webSocketConnectionList.addEventListener("click", (event) => {
  const connection = event.target.closest("[data-websocket-id]");
  if (!connection) return;
  state.selectedWebSocketId = connection.dataset.websocketId;
  state.selectedWebSocketMessageId = null;
  renderWebSockets();
});
els.webSocketMessages.addEventListener("click", (event) => {
  const message = event.target.closest("[data-websocket-message-id]");
  if (!message) return;
  state.selectedWebSocketMessageId = message.dataset.websocketMessageId;
  renderWebSockets();
});
els.callsTable.addEventListener("mouseover", (event) => networkOverviewController?.setMarker(event.target.closest("tr[data-request-id]")?.dataset.requestId || null));
els.callsTable.addEventListener("mouseleave", () => networkOverviewController?.setMarker(null));
els.previousCallPage.addEventListener("click", () => { state.requestPage = Math.max(1, state.requestPage - 1); renderCalls(); });
els.nextCallPage.addEventListener("click", () => { state.requestPage += 1; renderCalls(); });
els.closeDrawer.addEventListener("click", closeRequestDrawer);
els.drawerBackdrop.addEventListener("click", () => { closeRequestDrawer(); closeNetworkFilters(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { closeRequestDrawer(); closeNetworkFilters(); }
  if (["Enter", " "].includes(event.key) && event.target.matches("tr[data-request-id]")) { event.preventDefault(); openRequestDrawer(event.target.dataset.requestId); }
});
document.addEventListener("click", async (event) => {
  const copyCurl = event.target.closest("[data-copy-curl]");
  if (copyCurl) {
    const request = findRequest(copyCurl.dataset.copyCurl);
    if (!request) return;
    const preview = state.bodyPreviews.get(request.id) || await adapter.loadBodies(request.id);
    state.bodyPreviews.set(request.id, preview);
    return copyInspectorText(buildCurlCommand(request, preview.request), "cURL command");
  }
  const copyUrl = event.target.closest("[data-copy-request-url]");
  if (copyUrl) return copyInspectorText(findRequest(copyUrl.dataset.copyRequestUrl)?.url || "", "Request URL");
  const copyBody = event.target.closest("[data-copy-body]");
  if (copyBody) {
    const preview = state.bodyPreviews.get(copyBody.dataset.bodyRequestId);
    const parsed = parseBody(preview?.[copyBody.dataset.copyBody] || "");
    return copyInspectorText(parsed.formatted || parsed.source, `${copyBody.dataset.copyBody} body`);
  }
  const copyGraphql = event.target.closest("[data-copy-graphql]");
  if (copyGraphql) {
    const preview = state.bodyPreviews.get(state.selectedRequestId);
    const parsed = parseBody(preview?.request || "");
    return copyInspectorText(parsed.value?.query || parsed.source, "GraphQL operation");
  }
  const copyWebSocketMessage = event.target.closest("[data-copy-ws-message]");
  if (copyWebSocketMessage) {
    const message = state.webSockets.connections.flatMap((connection) => connection.messages).find((item) => item.id === copyWebSocketMessage.dataset.copyWsMessage);
    return copyInspectorText(message?.preview || "", "WebSocket message");
  }
  const bodyMode = event.target.closest("[data-body-mode]");
  if (bodyMode) {
    state.bodyViewModes.set(`${bodyMode.dataset.bodyRequestId}:${bodyMode.dataset.bodySide}`, bodyMode.dataset.bodyMode);
    const request = findRequest(bodyMode.dataset.bodyRequestId);
    const preview = state.bodyPreviews.get(bodyMode.dataset.bodyRequestId);
    if (request && preview) renderInspectorBodies(request, preview);
    return;
  }
  const bodyExpand = event.target.closest("[data-body-expand], [data-body-collapse]");
  if (bodyExpand) {
    const open = bodyExpand.hasAttribute("data-body-expand");
    bodyExpand.closest(".body-viewer")?.querySelectorAll("details").forEach((detail) => { detail.open = open; });
    return;
  }
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

document.addEventListener("input", (event) => {
  if (!event.target.matches("[data-body-search]")) return;
  const filter = event.target.value.trim().toLowerCase();
  event.target.closest(".body-viewer")?.querySelectorAll("[data-json-search-row]").forEach((row) => {
    row.hidden = Boolean(filter && !row.textContent.toLowerCase().includes(filter));
  });
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
document.querySelectorAll("[data-site-mode]").forEach((button) => button.addEventListener("click", () => { state.siteMode = button.dataset.siteMode; renderSiteAudit(); }));
els.siteGraphSearch.addEventListener("input", renderSiteAudit);
els.siteGraphLayout.addEventListener("change", () => { state.visualization.siteLayout = els.siteGraphLayout.value === "score" ? "score" : "topology"; saveVisualizationPreferences(); renderSiteAudit(); });
els.siteNodeMetric.addEventListener("change", () => { state.visualization.siteMetric = ["lcp", "findings"].includes(els.siteNodeMetric.value) ? els.siteNodeMetric.value : "transferSize"; saveVisualizationPreferences(); renderSiteAudit(); });
els.toggleMotion.addEventListener("click", () => {
  state.visualization.motionEnabled = !state.visualization.motionEnabled;
  saveVisualizationPreferences();
  renderSiteAudit();
});
els.resetSiteGraph.addEventListener("click", () => siteGraphController?.resetZoom());
els.routeResults.addEventListener("click", (event) => {
  const row = event.target.closest("[data-site-node-id]");
  if (!row) return;
  const run = state.liveSiteRun || state.currentSession.siteAudits?.at(-1);
  selectSiteRoute(buildSiteGraph(state.routeQueue, run, state.currentSession.url || run?.originalUrl || "", state.activeRouteUrl), row.dataset.siteNodeId);
});
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
    try {
      const input = els.savedCaptureList.querySelector(`[data-rename-id="${CSS.escape(id)}"]`);
      await store.rename(id, input.value);
      state.savedCaptures = await store.list();
      await renderSaved();
    } catch (error) { handlePanelError(error); }
  } else {
    state.pendingDeleteId = id;
    const capture = state.savedCaptures.find((item) => item.id === id);
    els.confirmMessage.textContent = `Delete ${capture?.name || "this capture"}? This cannot be undone.`;
    els.confirmDialog.showModal();
  }
});
els.confirmDialog.addEventListener("close", async () => {
  if (els.confirmDialog.returnValue !== "confirm" || !state.pendingDeleteId) { state.pendingDeleteId = null; return; }
  try {
    await store.remove(state.pendingDeleteId);
    state.compareSelection.delete(state.pendingDeleteId);
    state.pendingDeleteId = null;
    state.savedCaptures = await store.list();
    state.comparison = null;
    await renderSaved();
  } catch (error) { handlePanelError(error); }
});
els.compareCaptures.addEventListener("click", () => {
  const captures = [...state.compareSelection].map((id) => state.savedCaptures.find((capture) => capture.id === id)).filter(Boolean);
  state.comparison = captures.length === 2 ? compareCaptures(captures[0], captures[1]) : null;
  renderComparison();
});

function updateRecordingUi() {
  setButtonContent(els.toggleRecording, state.recording ? "pause" : "play", state.recording ? "Pause" : "Resume");
  els.toggleRecording.classList.toggle("paused", !state.recording);
  els.recordingDot.classList.toggle("paused", !state.recording);
  els.recordingLabel.textContent = devtoolsAvailable ? state.recording ? "Capturing live" : "Capture paused" : "Preview mode";
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    siteGraphController?.destroy();
    pauseJourneyPlayback();
  } else {
    renderActiveView(document.querySelector(".view.active")?.id || "overview");
  }
});

window.addEventListener("unhandledrejection", (event) => {
  if (!isExtensionContextInvalidatedError(event.reason)) return;
  event.preventDefault();
  handlePanelError(event.reason);
});

window.addEventListener("error", (event) => {
  if (!isExtensionContextInvalidatedError(event.error || event.message)) return;
  event.preventDefault();
  handlePanelError(event.error || event.message);
});

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
  applyTheme(state.theme);
  document.querySelectorAll("[data-timeline-speed]").forEach((button) => button.classList.toggle("active", Number(button.dataset.timelineSpeed) === state.visualization.timelineSpeed));
  updateRecordingUi();
  await adapter.start();
  render();
}

initialize().catch(handlePanelError);
