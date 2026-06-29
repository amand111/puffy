import test from "node:test";
import assert from "node:assert/strict";
import { buildPageFindings } from "../src/core/audit.js";
import { sanitizeRoutes } from "../src/core/crawler.js";
import { DEFAULT_AUDIT_PROFILE, SCHEMA_VERSION, createSession, migrateSession, serializableSession } from "../src/core/model.js";
import { analyzeSecurity, auditBodyPreview } from "../src/core/security.js";
import { resolveBudgets, scoreAudit, validateAuditProfile } from "../src/core/scoring.js";
import { normalizeRequest } from "../src/core/analysis.js";
import { diagnosticSession, harEntry } from "./fixtures.js";

test("detects API and document security issues with explicit confidence and fixes", () => {
  const session = diagnosticSession();
  const entry = harEntry({ url: "http://api.example.com/delete-user?token=secret", method: "GET" });
  entry.response.headers.push(
    { name: "access-control-allow-origin", value: "*" },
    { name: "access-control-allow-credentials", value: "true" },
    { name: "server", value: "framework/1.2" },
    { name: "set-cookie", value: "session=top-secret; Path=/" }
  );
  session.requests.push(normalizeRequest(entry, session.steps[1].id));
  const result = analyzeSecurity(session, { externalAssets: [{ url: "https://cdn.example.net/app.js", crossOrigin: true, integrity: false }] });
  const rules = new Set(result.findings.map((finding) => finding.ruleId));
  assert.ok(rules.has("mixed-content"));
  assert.ok(rules.has("sensitive-query"));
  assert.ok(rules.has("cors-wildcard-credentials"));
  assert.ok(rules.has("cookie-flags"));
  assert.ok(result.findings.every((finding) => finding.fixSuggestion && ["exact", "inferred", "manual-review"].includes(finding.confidence)));
  assert.ok(result.endpointRisks.length);
  assert.ok(result.riskScore > 0);
});

test("cookie values and body previews never enter serializable session data", () => {
  const session = createSession();
  const entry = harEntry({ url: "https://api.example.com/private" });
  entry.response.headers.push({ name: "set-cookie", value: "auth=raw-secret; Secure; HttpOnly; SameSite=Strict" });
  const request = normalizeRequest(entry);
  session.requests.push(request);
  const stored = JSON.stringify(serializableSession(session));
  assert.doesNotMatch(stored, /raw-secret/);
  assert.match(stored, /\[redacted\]/);
});

test("response-shape audit stores only shape and field names", () => {
  const request = normalizeRequest(harEntry({ url: "https://api.example.com/profile" }));
  const result = auditBodyPreview(request, { state: "available", response: JSON.stringify({ token: "raw-secret", user: { email: "person@example.com" } }) });
  assert.ok(result.findings.some((finding) => finding.ruleId === "sensitive-response-fields"));
  assert.deepEqual(result.shape.sensitiveKeys.sort(), ["email", "token"]);
  assert.doesNotMatch(JSON.stringify(result), /raw-secret|person@example.com/);
});

test("scores only available categories and caps critical categories", () => {
  const session = diagnosticSession();
  session.audit.pageSignals = { title: "Fixture" };
  const findings = [{ id: "a11y-1", category: "Accessibility", severity: "critical" }];
  const result = scoreAudit(session, findings, { findings: [], riskScore: 0 }, DEFAULT_AUDIT_PROFILE);
  assert.equal(result.categoryScores.find((item) => item.category === "accessibility").score, 49);
  assert.equal(result.coverage, 100);
  assert.ok(validateAuditProfile(DEFAULT_AUDIT_PROFILE));
  assert.equal(validateAuditProfile({ ...DEFAULT_AUDIT_PROFILE, weights: { ...DEFAULT_AUDIT_PROFILE.weights, seo: 11 } }), false);
});

test("applies matching route and journey budget overrides", () => {
  const profile = structuredClone(DEFAULT_AUDIT_PROFILE);
  profile.overrides.push({ routePattern: "/checkout/*", stepName: "Payment", budgets: { lcp: 1200, failures: 0 } });
  assert.equal(resolveBudgets(profile, "https://shop.example.com/checkout/card", "Payment").lcp, 1200);
  assert.equal(resolveBudgets(profile, "https://shop.example.com/products", "Payment").lcp, 2500);
});

test("migrates v3 sessions with partial v4 audit coverage", () => {
  const legacy = createSession();
  legacy.schemaVersion = 3;
  delete legacy.audit;
  delete legacy.siteAudits;
  const migrated = migrateSession(legacy);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.audit.migratedPartialCoverage, true);
  assert.deepEqual(migrated.siteAudits, []);
});

test("site route sanitizer remains same-origin and rejects logout and binary targets", () => {
  const routes = sanitizeRoutes([
    "/products#details", "/products", "/logout", "https://evil.example.net/", "/manual.pdf", "/cart"
  ], "https://shop.example.com/start", 25);
  assert.deepEqual(routes, ["https://shop.example.com/products", "https://shop.example.com/cart"]);
});

test("page audit findings remain deterministic and actionable", () => {
  const session = diagnosticSession();
  const findings = buildPageFindings({ title: "", description: "", lang: "", h1Count: 0, imagesMissingAlt: 2, imageCount: 3, formControlsWithoutLabels: 1, buttonsWithoutNames: 1, viewport: "", hasFavicon: false, axe: { violations: [], incomplete: [] } }, session);
  assert.ok(findings.some((finding) => finding.category === "Accessibility"));
  assert.ok(findings.some((finding) => finding.category === "SEO"));
  assert.ok(findings.every((finding) => finding.fixSuggestion));
});
