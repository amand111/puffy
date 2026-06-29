import { makeId } from "./utils.js";

export const SCHEMA_VERSION = 4;

export const DEFAULT_AUDIT_PROFILE = Object.freeze({
  id: "balanced",
  name: "Balanced website audit",
  weights: { experience: 25, delivery: 15, services: 10, reliability: 10, accessibility: 15, seo: 10, security: 10, bestPractices: 5 },
  budgets: { lcp: 2500, inp: 200, cls: 0.1, transferSize: 1_500_000, serviceP95: 800, failures: 0, accessibilityCritical: 0, securityRisk: 35 },
  overrides: []
});

/** @typedef {{id:string,name:string,kind:"initial"|"manual",startedAt:string,endedAt:string|null,status:"active"|"complete",requestIds:string[],longTaskIds:string[],interactionIds:string[],navigationUrls:string[]}} JourneyStep */
/** @typedef {{id:string,startedDateTime:string,method:string,url:string,domain:string,path:string,endpointTemplate:string,status:number,type:string,callKind:string,time:number,transferSize:number,requestPayloadBytes:number,dataPassingBytes:number,stepId:string|null,bodyState:"not-loaded"|"available"|"unavailable",initiator:object|null,resourceTiming:object|null}} RequestRecord */
/** @typedef {{navigation:object,longTasks:Array,interactions:Array,resources:Array,inp:number,lcp:number,cls:number,fcp:number}} PageTelemetry */
/** @typedef {{id:string,severity:"high"|"medium"|"low",category:string,title:string,evidence:string,recommendation:string,evidenceIds:string[]}} DiagnosticFinding */
/** @typedef {{id:string,category:string,severity:string,title:string,description:string,fixSuggestion:string,evidenceIds:string[],confidence?:"exact"|"inferred"|"manual-review"}} AuditFinding */
/** @typedef {{id:string,kind:string,label:string,requestIds:string[],detail:string}} SecurityEvidence */
/** @typedef {AuditFinding & {ruleId:string,confidence:"exact"|"inferred"|"manual-review",endpointKey:string|null}} SecurityFinding */
/** @typedef {{id:string,label:string,requestIds:string[],endpointKey:string|null,sourceView:string}} ApiReference */
/** @typedef {{category:string,score:number,weight:number,coverage:number,status:string,findingIds:string[]}} CategoryScore */
/** @typedef {{id:string,name:string,weights:Record<string,number>,budgets:Record<string,number>,overrides:Array}} AuditProfile */
/** @typedef {{url:string,title:string,score:number,categoryScores:CategoryScore[],findingIds:string[],capturedAt:string}} RouteAuditResult */
/** @typedef {{id:string,startedAt:string,endedAt:string|null,status:string,source:string,originalUrl:string,routes:RouteAuditResult[]}} SiteAuditRun */
/** @typedef {{requestId:string,state:"available"|"unavailable"|"not-audited",findingIds:string[],shape:object|null}} BodyAuditResult */
/** @typedef {{search:string,steps:string[],methods:string[],statuses:string[],types:string[],domains:string[],party:string,security:string,cache:string,compression:string,body:string,apiStyle:string,protocols:string[],initiators:string[],confidence:string[],durationMin:number,durationMax:number,transferMin:number,transferMax:number,timeStart:number,timeEnd:number}} NetworkFilterState */
/** @typedef {{schemaVersion:number,id:string,label:string,startedAt:string,endedAt:string|null,url:string,title:string,requests:RequestRecord[],steps:JourneyStep[],pageMetrics:object,telemetry:PageTelemetry,pageSnapshot:object|null,audit:object,siteAudits:SiteAuditRun[]}} CaptureSession */
/** @typedef {{schemaVersion:number,id:string,name:string,note:string,savedAt:string,session:CaptureSession}} SavedCapture */

export function createJourneyStep(name, kind = "manual", startedAt = new Date().toISOString()) {
  return {
    id: makeId("step"),
    name: String(name || "Unnamed step").trim(),
    kind,
    startedAt,
    endedAt: null,
    status: "active",
    requestIds: [],
    longTaskIds: [],
    interactionIds: [],
    navigationUrls: []
  };
}

export function createSession(label = "Live capture", now = new Date().toISOString()) {
  const initialStep = createJourneyStep("Initial page load", "initial", now);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId("session"),
    label,
    startedAt: now,
    endedAt: null,
    url: "",
    title: "",
    requests: [],
    steps: [initialStep],
    activeStepId: initialStep.id,
    pageMetrics: {},
    telemetry: { navigation: {}, longTasks: [], interactions: [], resources: [], inp: 0, lcp: 0, cls: 0, fcp: 0 },
    pageSnapshot: null,
    audit: { status: "not-run", ranAt: null, profile: structuredClone(DEFAULT_AUDIT_PROFILE), findings: [], securityFindings: [], securityEvidence: [], categoryScores: [], overallScore: null, coverage: 0, pageSignals: null, bodyAudits: [] },
    siteAudits: [],
    notes: []
  };
}

export function getActiveStep(session) {
  return session.steps.find((step) => step.id === session.activeStepId) || null;
}

export function startStep(session, name, startedAt = new Date().toISOString()) {
  stopActiveStep(session, startedAt);
  const step = createJourneyStep(name, "manual", startedAt);
  session.steps.push(step);
  session.activeStepId = step.id;
  return step;
}

export function stopActiveStep(session, endedAt = new Date().toISOString()) {
  const active = getActiveStep(session);
  if (!active) return null;
  active.endedAt = endedAt;
  active.status = "complete";
  session.activeStepId = null;
  return active;
}

export function assignRequestToStep(session, request) {
  const step = getActiveStep(session);
  request.stepId = step?.id || null;
  if (step && !step.requestIds.includes(request.id)) step.requestIds.push(request.id);
  return request;
}

export function mergeTelemetry(session, sample) {
  if (!sample) return;
  session.url = sample.url || session.url;
  session.title = sample.title || session.title;
  session.pageMetrics = { ...session.pageMetrics, ...sample.navigation, url: sample.url, title: sample.title };
  session.telemetry = {
    ...session.telemetry,
    navigation: sample.navigation || session.telemetry.navigation,
    inp: Number(sample.inp || session.telemetry.inp || 0),
    lcp: Number(sample.lcp || session.telemetry.lcp || 0),
    cls: Number(sample.cls || session.telemetry.cls || 0),
    fcp: Number(sample.fcp || session.telemetry.fcp || 0)
  };
  mergeTelemetryItems(session.telemetry.longTasks, sample.longTasks || []);
  mergeTelemetryItems(session.telemetry.interactions, sample.interactions || []);
  mergeTelemetryItems(session.telemetry.resources, sample.resources || []);
  assignTelemetryToSteps(session, sample);

  const initial = session.steps.find((step) => step.kind === "initial" && step.status === "active");
  if (initial && sample.navigation?.loadEventEnd > 0) {
    initial.endedAt = new Date(sample.observedAt || Date.now()).toISOString();
    initial.status = "complete";
    if (session.activeStepId === initial.id) session.activeStepId = null;
  }
}

function mergeTelemetryItems(target, incoming) {
  const known = new Set(target.map((item) => item.id));
  for (const item of incoming) {
    if (!known.has(item.id)) {
      target.push(item);
      known.add(item.id);
    }
  }
}

function assignTelemetryToSteps(session, sample) {
  for (const item of [...(sample.longTasks || []), ...(sample.interactions || [])]) {
    const absolute = Number(item.absoluteStart || 0);
    const step = session.steps.find((candidate) => {
      const start = new Date(candidate.startedAt).getTime();
      const end = candidate.endedAt ? new Date(candidate.endedAt).getTime() : Infinity;
      return absolute >= start && absolute <= end;
    });
    if (!step) continue;
    const list = item.kind === "longtask" ? step.longTaskIds : step.interactionIds;
    if (!list.includes(item.id)) list.push(item.id);
  }
}

export function recordNavigation(session, url) {
  session.url = url || session.url;
  const active = getActiveStep(session);
  if (active && url && !active.navigationUrls.includes(url)) active.navigationUrls.push(url);
}

export function serializableSession(session) {
  return JSON.parse(JSON.stringify(session, (key, value) => {
    if (["activeStepId", "bodyPreview", "responsePreview", "requestPreview", "postData", "requestHandle", "rawValue", "cookieValue"].includes(key)) return undefined;
    return value;
  }));
}

export function validateCapture(value) {
  return Boolean(value && value.schemaVersion === SCHEMA_VERSION && typeof value.id === "string" && Array.isArray(value.requests) && Array.isArray(value.steps));
}

export function migrateSession(value) {
  if (!value || !Array.isArray(value.requests) || !Array.isArray(value.steps)) return null;
  const session = structuredClone(value);
  if (session.schemaVersion === SCHEMA_VERSION) return session;
  if (session.schemaVersion !== 3) return null;
  session.schemaVersion = SCHEMA_VERSION;
  session.audit = { status: "not-run", ranAt: null, profile: structuredClone(DEFAULT_AUDIT_PROFILE), findings: [], securityFindings: [], securityEvidence: [], categoryScores: [], overallScore: null, coverage: 0, pageSignals: null, bodyAudits: [], migratedPartialCoverage: true };
  session.siteAudits = [];
  return session;
}
