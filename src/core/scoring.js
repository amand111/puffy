import { DEFAULT_AUDIT_PROFILE } from "./model.js";

const CATEGORIES = ["experience", "delivery", "services", "reliability", "accessibility", "seo", "security", "bestPractices"];
const SEVERITY_PENALTY = { critical: 35, high: 20, serious: 20, medium: 10, moderate: 10, low: 4, minor: 4 };

export function validateAuditProfile(profile) {
  const weights = profile?.weights || {};
  return CATEGORIES.every((category) => Number.isFinite(Number(weights[category])) && Number(weights[category]) >= 0) && Math.round(CATEGORIES.reduce((sum, category) => sum + Number(weights[category] || 0), 0)) === 100;
}

export function scoreAudit(session, findings, securityResult, profile = session.audit?.profile || DEFAULT_AUDIT_PROFILE) {
  if (!validateAuditProfile(profile)) throw new Error("Audit profile weights must total 100%.");
  const metricCoverage = session.audit?.pageSignals ? 1 : 0;
  const availability = {
    experience: Boolean(session.telemetry), delivery: Boolean(session.requests?.length), services: Boolean(session.requests?.length),
    reliability: Boolean(session.requests?.length), accessibility: metricCoverage, seo: metricCoverage,
    security: Boolean(session.requests?.length || metricCoverage), bestPractices: metricCoverage
  };
  const combined = [...findings, ...(securityResult?.findings || [])];
  const scores = CATEGORIES.map((category) => {
    if (!availability[category]) return { category, score: null, weight: profile.weights[category], coverage: 0, status: "unavailable", findingIds: [] };
    const categoryFindings = combined.filter((finding) => normalizeCategory(finding.category) === category);
    let score = 100;
    for (const finding of categoryFindings) score -= SEVERITY_PENALTY[finding.severity] || 5;
    if (["accessibility", "security", "reliability"].includes(category) && categoryFindings.some((finding) => ["critical", "high", "serious"].includes(finding.severity))) score = Math.min(score, 49);
    return { category, score: Math.max(0, Math.round(score)), weight: profile.weights[category], coverage: 100, status: score >= 90 ? "good" : score >= 70 ? "warn" : "bad", findingIds: categoryFindings.map((finding) => finding.id) };
  });
  const available = scores.filter((item) => item.score !== null);
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const overallScore = availableWeight ? Math.round(available.reduce((sum, item) => sum + item.score * item.weight, 0) / availableWeight) : null;
  const totalWeight = CATEGORIES.reduce((sum, category) => sum + profile.weights[category], 0);
  const coverage = totalWeight ? Math.round(availableWeight / totalWeight * 100) : 0;
  return { categoryScores: scores, overallScore, coverage };
}

function normalizeCategory(value = "") {
  const text = String(value).toLowerCase();
  if (/access/.test(text)) return "accessibility";
  if (/seo/.test(text)) return "seo";
  if (/security|privacy|cors|cookie|supply/.test(text)) return "security";
  if (/reliab|failure/.test(text)) return "reliability";
  if (/service|api pattern/.test(text)) return "services";
  if (/delivery|payload|asset/.test(text)) return "delivery";
  if (/experience|respons|vital/.test(text)) return "experience";
  return "bestPractices";
}

export function evaluateBudgets(session, securityResult, profile = session.audit?.profile || DEFAULT_AUDIT_PROFILE) {
  const activeStep = session.steps?.find((step) => step.id === session.activeStepId) || session.steps?.at(-1);
  const budgets = resolveBudgets(profile, session.url, activeStep?.name || "");
  const values = {
    lcp: Number(session.telemetry?.lcp || 0), inp: Number(session.telemetry?.inp || 0), cls: Number(session.telemetry?.cls || 0),
    transferSize: session.requests.reduce((sum, request) => sum + request.transferSize, 0),
    serviceP95: percentile(session.requests.filter((request) => ["api", "xhr", "fetch"].includes(request.callKind)).map((request) => request.time), 95),
    failures: session.requests.filter((request) => request.status >= 400).length,
    accessibilityCritical: session.audit?.findings?.filter((finding) => /access/i.test(finding.category) && ["critical", "serious"].includes(finding.severity)).length || 0,
    securityRisk: securityResult?.riskScore || 0
  };
  return Object.entries(budgets).map(([key, limit]) => ({ key, value: values[key] || 0, limit: Number(limit), passed: Number(values[key] || 0) <= Number(limit) }));
}

export function resolveBudgets(profile, url = "", stepName = "") {
  const budgets = { ...(profile?.budgets || {}) };
  for (const override of profile?.overrides || []) {
    const routeMatches = !override.routePattern || globMatches(url, override.routePattern);
    const stepMatches = !override.stepName || override.stepName === stepName;
    if (routeMatches && stepMatches) Object.assign(budgets, override.budgets || {});
  }
  return budgets;
}

function globMatches(value, glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value) || new RegExp(escaped, "i").test(new URL(value, "https://puffy.invalid").pathname);
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentileValue / 100 * sorted.length) - 1)];
}
