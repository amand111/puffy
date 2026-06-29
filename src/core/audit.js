import { makeId } from "./utils.js";
import { analyzeSecurity } from "./security.js";
import { evaluateBudgets, scoreAudit } from "./scoring.js";

export const PAGE_AUDIT_EXPRESSION = `(() => {
  const clean = (value, max = 300) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
  const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return ""; } };
  const links = [...document.querySelectorAll("a[href]")].map((node) => absolute(node.getAttribute("href"))).filter(Boolean);
  const externalAssets = [...document.querySelectorAll("script[src],link[rel=stylesheet][href]")].map((node) => ({ url: absolute(node.src || node.href), integrity: Boolean(node.integrity), crossOrigin: Boolean(node.src || node.href) && new URL(node.src || node.href, location.href).origin !== location.origin }));
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((node) => Number(node.tagName.slice(1)));
  const images = [...document.images];
  return {
    url: location.href, title: clean(document.title), lang: clean(document.documentElement.lang, 30),
    description: clean(document.querySelector('meta[name="description"]')?.content), canonical: absolute(document.querySelector('link[rel="canonical"]')?.href),
    robots: clean(document.querySelector('meta[name="robots"]')?.content), viewport: clean(document.querySelector('meta[name="viewport"]')?.content),
    h1Count: document.querySelectorAll("h1").length, headings, linkCount: links.length, links: [...new Set(links)].slice(0, 500),
    imageCount: images.length, imagesMissingAlt: images.filter((image) => !image.hasAttribute("alt")).length,
    formControlsWithoutLabels: [...document.querySelectorAll("input,select,textarea")].filter((control) => !control.labels?.length && !control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby") && control.type !== "hidden").length,
    buttonsWithoutNames: [...document.querySelectorAll("button,[role=button]")].filter((node) => !clean(node.innerText || node.getAttribute("aria-label") || node.getAttribute("aria-labelledby"))).length,
    externalAssets, hasManifest: Boolean(document.querySelector('link[rel="manifest"]')), hasFavicon: Boolean(document.querySelector('link[rel~="icon"]')),
    axe: window.__puffyAxeResult || null, vitalsAttribution: window.__puffyVitals || {}
  };
})()`;

export class AuditEngine {
  constructor(adapter) { this.adapter = adapter; }

  async run(session) {
    const pageSignals = await this.adapter.runPageAudit?.() || session.pageSnapshot || null;
    const findings = buildPageFindings(pageSignals, session);
    session.audit.pageSignals = pageSignals;
    const security = analyzeSecurity(session, pageSignals);
    session.audit.findings = findings;
    session.audit.securityFindings = security.findings;
    session.audit.securityEvidence = security.evidence;
    session.audit.endpointRisks = security.endpointRisks;
    session.audit.securityRisk = security.riskScore;
    const scoring = scoreAudit(session, findings, security, session.audit.profile);
    Object.assign(session.audit, scoring, { status: "complete", ranAt: new Date().toISOString() });
    session.audit.budgetResults = evaluateBudgets(session, security, session.audit.profile);
    return session.audit;
  }
}

export function buildPageFindings(signals, session) {
  const findings = [];
  const add = (category, severity, title, description, fixSuggestion, evidenceIds = []) => findings.push({ id: makeId("audit-finding"), category, severity, title, description, fixSuggestion, evidenceIds, confidence: "exact" });
  if (!signals) return findings;
  if (!signals.title) add("SEO", "high", "Page title is missing", "Search engines and users do not receive a meaningful document title.", "Add a unique, descriptive title element.");
  else if (signals.title.length < 15 || signals.title.length > 65) add("SEO", "medium", "Page title length needs review", `The title contains ${signals.title.length} characters.`, "Keep the title specific and generally within 15 to 65 characters.");
  if (!signals.description) add("SEO", "medium", "Meta description is missing", "No page description was detected.", "Add a concise, route-specific meta description.");
  if (signals.h1Count !== 1) add("SEO", "medium", "Heading landmark needs review", `${signals.h1Count} H1 elements were found.`, "Use one descriptive H1 for the page's primary topic.");
  if (!signals.lang) add("Accessibility", "serious", "Document language is missing", "The html element has no language value.", "Set an accurate lang attribute on the html element.");
  if (signals.imagesMissingAlt) add("Accessibility", "serious", "Images are missing alternative text", `${signals.imagesMissingAlt} of ${signals.imageCount} images have no alt attribute.`, "Provide meaningful alt text or an empty alt attribute for decorative images.");
  if (signals.formControlsWithoutLabels) add("Accessibility", "serious", "Form controls lack accessible labels", `${signals.formControlsWithoutLabels} controls have no associated or ARIA label.`, "Associate each control with a visible label or an accurate accessible name.");
  if (signals.buttonsWithoutNames) add("Accessibility", "serious", "Buttons lack accessible names", `${signals.buttonsWithoutNames} interactive controls have no accessible name.`, "Add visible text or an accurate aria-label.");
  for (const violation of signals.axe?.violations || []) add("Accessibility", violation.impact || "medium", violation.help || violation.id, `${violation.nodes?.length || 0} element(s): ${violation.description || "Automated accessibility failure."}`, violation.helpUrl ? `Resolve the rule guidance at ${violation.helpUrl}.` : "Correct the affected markup and retest.", (violation.nodes || []).map((node) => node.target?.join(" ")).filter(Boolean));
  if (!signals.viewport) add("Best practices", "medium", "Viewport metadata is missing", "Mobile layout behavior may be inconsistent.", "Add a responsive viewport meta tag.");
  if (!signals.hasFavicon) add("Best practices", "low", "Site icon is missing", "No favicon link was detected.", "Provide a stable site icon for browser and bookmark surfaces.");
  const load = Number(session.pageMetrics?.loadEventEnd || 0);
  if (load > 4000) add("Experience", "high", "Slow page load", `The load event completed in ${Math.round(load)} ms.`, "Prioritize critical resources and remove blocking delivery work.");
  if (session.telemetry?.lcp > 2500) add("Experience", "high", "Largest content rendered late", `LCP was ${Math.round(session.telemetry.lcp)} ms.`, "Use the LCP attribution and request chain to optimize the responsible element and resource.");
  if (session.requests.reduce((sum, request) => sum + request.transferSize, 0) > 1_500_000) add("Delivery", "medium", "Large page transfer", "The capture exceeded the default 1.5 MB transfer budget.", "Compress, cache, resize, and defer non-critical resources.");
  if (session.requests.some((request) => request.status >= 500)) add("Reliability", "high", "Server errors were observed", "At least one request returned a 5xx response.", "Resolve the upstream failure and verify retry and fallback behavior.", session.requests.filter((request) => request.status >= 500).map((request) => request.id));
  return findings;
}

export function buildAuditNarrative(session) {
  const audit = session.audit;
  if (audit?.status !== "complete") return ["Run a full audit to add accessibility, SEO, security, and best-practice analysis."];
  const weakest = [...audit.categoryScores].filter((item) => item.score !== null).sort((a, b) => a.score - b.score).slice(0, 2);
  const high = [...audit.findings, ...audit.securityFindings].filter((finding) => ["critical", "high", "serious"].includes(finding.severity));
  return [
    `The full audit scored ${audit.overallScore}/100 with ${audit.coverage}% weighted coverage. ${weakest.map((item) => `${label(item.category)} is ${item.score}`).join("; ")}.`,
    high.length ? `${high.length} high-impact issue(s) should be addressed first. The recommendations are deterministic and linked to captured evidence.` : "No high-impact automated finding was detected; manual review still applies."
  ];
}

function label(value) { return value.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()); }
