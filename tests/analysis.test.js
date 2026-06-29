import test from "node:test";
import assert from "node:assert/strict";
import { buildDependencies, buildFindings, compareCaptures, deduplicateRequests, detectPatterns, normalizeRequest, summarize, summarizeStep } from "../src/core/analysis.js";
import { buildReportHtml } from "../src/core/report.js";
import { diagnosticSession, harEntry, requestFrom } from "./fixtures.js";

test("normalizes HAR requests, redacts headers, and deduplicates backfill/live entries", () => {
  const entry = harEntry({ url: "https://api.example.com/users/123", postData: '{"token":"secret"}' });
  const first = normalizeRequest(entry, "step-1");
  const second = normalizeRequest(entry, "step-1");
  const unique = deduplicateRequests([first, second]);
  assert.equal(unique.length, 1);
  assert.equal(first.endpointTemplate, "/users/:id");
  assert.equal(first.requestHeaders.find((header) => header.name === "authorization").value, "[redacted]");
  assert.equal(first.stepId, "step-1");
  assert.ok(first.bodyFingerprint);
  assert.equal(first.postData, undefined);
});

test("detects retries, duplicates, N+1 calls, serial chains, and preflight overhead", () => {
  const session = diagnosticSession();
  const patterns = detectPatterns(session);
  const types = new Set(patterns.map((pattern) => pattern.type));
  assert.ok(types.has("retry"));
  assert.ok(types.has("n-plus-one"));
  assert.ok(types.has("serial-chain"));
  assert.ok(types.has("preflight"));
});

test("builds exact initiator edges and a weighted critical chain", () => {
  const session = diagnosticSession();
  const dependencies = buildDependencies(session);
  assert.ok(dependencies.edges.some((edge) => edge.confidence === "exact"));
  assert.ok(dependencies.criticalChain.length >= 2);
  assert.ok(dependencies.criticalWeight > 0);
});

test("attributes request and responsiveness data to journey steps", () => {
  const session = diagnosticSession();
  const step = session.steps.find((item) => item.name === "Add to cart");
  const summary = summarizeStep(session, step);
  assert.ok(summary.requestCount >= 8);
  assert.equal(summary.interactions, 1);
  assert.equal(summary.longTasks, 1);
  assert.equal(summary.maxInteraction, 360);
});

test("generates traceable findings and capture comparisons", () => {
  const before = diagnosticSession();
  const after = diagnosticSession();
  after.requests.push(requestFrom({ url: "https://api.example.com/new-endpoint", time: 1200, bytes: 500000 }, after.steps[1].id));
  const findings = buildFindings(after);
  assert.ok(findings.length > 0);
  assert.ok(findings.some((finding) => finding.evidenceIds.length));
  const comparison = compareCaptures(before, after);
  assert.ok(comparison.metrics.find((metric) => metric.key === "requestCount").delta > 0);
  assert.ok(comparison.addedEndpoints.some((endpoint) => endpoint.includes("new-endpoint")));
  assert.ok(summarize(after).requestCount > summarize(before).requestCount);
});

test("builds a standalone report with journeys, dependencies, patterns, and comparisons", () => {
  const first = { id: "capture-1", name: "Before", session: diagnosticSession() };
  const second = { id: "capture-2", name: "After", session: diagnosticSession() };
  const html = buildReportHtml(second.session, { comparisonCaptures: [first, second], visibleCode: "Visible snapshot" });
  assert.match(html, /Journey timeline/);
  assert.match(html, /Critical dependency chain/);
  assert.match(html, /Detected request patterns/);
  assert.match(html, /Saved capture comparison/);
  assert.doesNotMatch(html, /Bearer secret/);
});

test("report includes full audit, security evidence anchors, and route matrix", () => {
  const session = diagnosticSession();
  session.audit.status = "complete";
  session.audit.overallScore = 72;
  session.audit.coverage = 100;
  session.audit.categoryScores = [{ category: "security", score: 49, coverage: 100 }];
  session.audit.findings = [];
  session.audit.securityRisk = 61;
  session.audit.securityFindings = [{ severity: "high", confidence: "exact", title: "Unsafe API", description: "Evidence", fixSuggestion: "Fix it.", requestIds: [session.requests[0].id] }];
  session.siteAudits = [{ routes: [{ url: session.url, score: 72, findings: [], metrics: { lcp: 1900, transferSize: 1000 } }] }];
  const html = buildReportHtml(session);
  assert.match(html, /Full audit/);
  assert.match(html, /Security and privacy analysis/);
  assert.match(html, /Site audit route matrix/);
  assert.match(html, new RegExp(`href="#request-${session.requests[0].id}`));
});
