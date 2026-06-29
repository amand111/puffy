import { getDomain, getHeader, isSameSite, makeId } from "./utils.js";
import { isServiceRequest } from "./analysis.js";

const SEVERITY_WEIGHT = { critical: 34, high: 22, medium: 10, low: 4 };
const CONFIDENCE_WEIGHT = { exact: 1, inferred: 0.65, "manual-review": 0.35 };
const SENSITIVE_NAME = /token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|session|jwt|email|phone|ssn|credit|card/i;

export function analyzeSecurity(session, pageSignals = session.audit?.pageSignals) {
  const findings = [];
  const evidence = [];
  const origin = getDomain(session.url);
  const add = ({ ruleId, severity = "medium", confidence = "exact", title, description, fixSuggestion, requests = [], endpointKey = null, category = "API security" }) => {
    const requestIds = [...new Set(requests.map((request) => request.id).filter(Boolean))];
    const evidenceItem = { id: makeId("security-evidence"), kind: ruleId, label: title, requestIds, detail: description };
    evidence.push(evidenceItem);
    findings.push({ id: makeId("security-finding"), ruleId, category, severity, confidence, title, description, fixSuggestion, evidenceIds: [evidenceItem.id], requestIds, endpointKey: endpointKey || endpointFor(requests[0]) });
  };

  for (const request of session.requests) {
    let parsed;
    try { parsed = new URL(request.url); } catch { continue; }
    const endpointKey = endpointFor(request);
    if (parsed.protocol === "http:" && String(session.url).startsWith("https:")) add({ ruleId: "mixed-content", severity: "high", title: "Mixed-content request", description: `${request.method} ${request.domain}${request.endpointTemplate} was sent over HTTP from an HTTPS page.`, fixSuggestion: "Serve this endpoint over HTTPS and upgrade the request URL.", requests: [request], endpointKey });
    const sensitiveParams = [...parsed.searchParams.keys()].filter((name) => SENSITIVE_NAME.test(name));
    if (sensitiveParams.length) add({ ruleId: "sensitive-query", severity: "high", title: "Sensitive data may be present in the URL", description: `Query keys ${sensitiveParams.join(", ")} can leak through logs, history, and referrers.`, fixSuggestion: "Move secrets and personal data to an encrypted request body or authorization header.", requests: [request], endpointKey });
    if (request.method === "GET" && request.hasRequestBody) add({ ruleId: "get-body", severity: "medium", title: "GET request contains a body", description: "Intermediaries can ignore or mishandle GET bodies.", fixSuggestion: "Use query parameters for retrieval or a suitable non-GET method for body semantics.", requests: [request], endpointKey });
    if (request.method === "GET" && /create|update|delete|remove|logout|purchase|checkout|charge|reset|invite/i.test(request.path)) add({ ruleId: "state-get", severity: "high", confidence: "inferred", title: "GET may perform a state-changing action", description: `${request.endpointTemplate} has action-oriented naming that merits CSRF and method review.`, fixSuggestion: "Use POST, PUT, PATCH, or DELETE with CSRF protection and explicit authorization.", requests: [request], endpointKey });
    if (isServiceRequest(request) && request.status >= 200 && request.status < 300 && !/json|graphql|problem\+json/i.test(request.contentType || "")) add({ ruleId: "api-content-type", severity: "low", confidence: "inferred", title: "Unexpected API content type", description: `The successful API response used ${request.contentType || "no exposed content type"}.`, fixSuggestion: "Return an explicit, correctly scoped Content-Type and add nosniff protection.", requests: [request], endpointKey });
    if (request.serverIPAddress && getHeader(request.responseHeaders, "server")) add({ ruleId: "server-disclosure", severity: "low", title: "Server technology is disclosed", description: `The response exposes a Server header for ${request.domain}.`, fixSuggestion: "Remove unnecessary server version and implementation headers.", requests: [request], endpointKey });
    if (getHeader(request.responseHeaders, "x-powered-by")) add({ ruleId: "powered-by", severity: "low", title: "Framework disclosure header", description: "X-Powered-By reveals implementation information.", fixSuggestion: "Disable the X-Powered-By header in the application or proxy.", requests: [request], endpointKey });

    const allowOrigin = getHeader(request.responseHeaders, "access-control-allow-origin");
    const allowCredentials = getHeader(request.responseHeaders, "access-control-allow-credentials");
    if (allowOrigin === "*" && /true/i.test(allowCredentials)) add({ ruleId: "cors-wildcard-credentials", severity: "critical", title: "Unsafe credentialed CORS policy", description: "The response combines wildcard origin access with credentials.", fixSuggestion: "Allow only trusted origins and never combine wildcard origins with credentials.", requests: [request], endpointKey });
    if (allowOrigin && allowOrigin !== "*" && !getHeader(request.responseHeaders, "vary").toLowerCase().includes("origin")) add({ ruleId: "cors-vary-origin", severity: "medium", confidence: "inferred", title: "CORS response may be cached across origins", description: "A specific Access-Control-Allow-Origin value was returned without Vary: Origin.", fixSuggestion: "Add Vary: Origin whenever the allowed origin is selected dynamically.", requests: [request], endpointKey });
    const allowMethods = getHeader(request.responseHeaders, "access-control-allow-methods");
    if (/\*/.test(allowMethods) || /TRACE|CONNECT/i.test(allowMethods)) add({ ruleId: "cors-broad-methods", severity: "medium", title: "Broad CORS methods", description: `The exposed CORS methods are ${allowMethods}.`, fixSuggestion: "Restrict CORS methods to those required by this endpoint.", requests: [request], endpointKey });

    const sensitiveResponse = request.requestHeaders.some((header) => /authorization|cookie|x-api-key/i.test(header.name));
    if (sensitiveResponse && !request.fromCache && !/no-store|private/i.test(request.cacheControl || "")) add({ ruleId: "sensitive-cache", severity: "medium", confidence: "inferred", title: "Authenticated response lacks a restrictive cache policy", description: "The request carries authentication material but the response does not expose no-store or private caching.", fixSuggestion: "Use Cache-Control: no-store or a carefully designed private caching policy for sensitive responses.", requests: [request], endpointKey });
    if (!isSameSite(request.domain, origin) && (sensitiveParams.length || request.requestHeaders.some((header) => /authorization|cookie/i.test(header.name)))) add({ ruleId: "third-party-sensitive", severity: "high", confidence: "inferred", title: "Sensitive data may cross a third-party boundary", description: `Authentication or sensitive query metadata was sent to ${request.domain}.`, fixSuggestion: "Minimize shared data and verify the third party's purpose, contract, and retention policy.", requests: [request], endpointKey });

    for (const cookie of request.cookieMetadata || []) {
      const missing = [!cookie.secure && "Secure", !cookie.httpOnly && "HttpOnly", !cookie.sameSite && "SameSite"].filter(Boolean);
      if (missing.length) add({ ruleId: "cookie-flags", severity: missing.includes("Secure") ? "high" : "medium", title: "Cookie security attributes are incomplete", description: `${cookie.name} is missing ${missing.join(", ")}. No cookie value was retained.`, fixSuggestion: "Set Secure, HttpOnly, and an intentional SameSite policy; minimize Domain and Path scope.", requests: [request], endpointKey });
      if (cookie.hostPrefix && (!cookie.secure || cookie.domain || cookie.path !== "/")) add({ ruleId: "host-cookie-prefix", severity: "high", title: "Invalid __Host- cookie constraints", description: `${cookie.name} does not satisfy all __Host- prefix requirements.`, fixSuggestion: "Set Secure, omit Domain, and use Path=/ for __Host- cookies.", requests: [request], endpointKey });
    }

    if (request.graphql?.kind === "mutation" && request.method === "GET") add({ ruleId: "graphql-get-mutation", severity: "high", title: "GraphQL mutation sent with GET", description: `${request.graphql.name} can be cached or triggered unintentionally.`, fixSuggestion: "Send GraphQL mutations with POST and enforce CSRF and authorization checks.", requests: [request], endpointKey });
    if (/introspectionquery|__schema|__type/i.test(request.graphql?.name || request.path)) add({ ruleId: "graphql-introspection", severity: "medium", confidence: "inferred", title: "GraphQL introspection traffic detected", description: "Introspection can expand production schema exposure.", fixSuggestion: "Disable or authorize production introspection when it is not operationally required.", requests: [request], endpointKey });
  }

  auditDocumentHeaders(session, pageSignals, add);
  for (const body of session.audit?.bodyAudits || []) for (const finding of body.findings || []) add({ ...finding, requests: session.requests.filter((request) => request.id === body.requestId), endpointKey: endpointFor(session.requests.find((request) => request.id === body.requestId)) });

  const endpointRisks = scoreEndpoints(findings);
  const riskScore = Math.min(100, Math.round(endpointRisks.reduce((sum, item) => sum + item.risk, 0) / Math.max(1, Math.sqrt(endpointRisks.length))));
  return { findings: dedupeFindings(findings), evidence, endpointRisks, riskScore };
}

function auditDocumentHeaders(session, signals, add) {
  const documentRequest = session.requests.find((request) => request.type === "document" && request.status < 400);
  if (!documentRequest) return;
  const headers = documentRequest.responseHeaders;
  const checks = [
    ["content-security-policy", "csp", "high", "Content Security Policy is missing", "Add a restrictive, nonce- or hash-based Content-Security-Policy."],
    ["strict-transport-security", "hsts", "high", "HSTS is missing", "Add Strict-Transport-Security after confirming all subdomains support HTTPS."],
    ["x-content-type-options", "nosniff", "medium", "MIME sniffing protection is missing", "Set X-Content-Type-Options: nosniff."],
    ["referrer-policy", "referrer-policy", "medium", "Referrer policy is missing", "Set a privacy-preserving Referrer-Policy such as strict-origin-when-cross-origin."],
    ["permissions-policy", "permissions-policy", "low", "Permissions Policy is missing", "Disable browser capabilities the application does not use."]
  ];
  for (const [header, ruleId, severity, title, fixSuggestion] of checks) if (!getHeader(headers, header)) add({ ruleId, severity, title, description: `${header} was not exposed on the main document response.`, fixSuggestion, requests: [documentRequest], category: "Page security" });
  for (const asset of signals?.externalAssets || []) if (!asset.integrity && asset.crossOrigin) add({ ruleId: "subresource-integrity", severity: "medium", confidence: "manual-review", title: "External asset has no integrity metadata", description: `${asset.url} is loaded from another origin without SRI metadata.`, fixSuggestion: "Pin the asset and add an integrity hash, or self-host it when operationally appropriate.", requests: session.requests.filter((request) => request.url === asset.url), category: "Supply chain" });
}

function endpointFor(request) { return request ? `${request.method} ${request.domain}${request.endpointTemplate}` : null; }

function scoreEndpoints(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = finding.endpointKey || "Page-level signals";
    if (!groups.has(key)) groups.set(key, { endpointKey: key, risk: 0, findingIds: [], requestIds: [] });
    const item = groups.get(key);
    item.risk = Math.min(100, item.risk + (SEVERITY_WEIGHT[finding.severity] || 4) * (CONFIDENCE_WEIGHT[finding.confidence] || 0.35));
    item.findingIds.push(finding.id);
    item.requestIds.push(...finding.requestIds);
  }
  return [...groups.values()].map((item) => ({ ...item, risk: Math.round(item.risk), requestIds: [...new Set(item.requestIds)] })).sort((a, b) => b.risk - a.risk);
}

function dedupeFindings(findings) {
  const seen = new Map();
  for (const finding of findings) {
    const key = `${finding.ruleId}|${finding.endpointKey || "page"}|${finding.description}`;
    if (!seen.has(key)) seen.set(key, finding);
    else seen.get(key).requestIds = [...new Set([...seen.get(key).requestIds, ...finding.requestIds])];
  }
  return [...seen.values()];
}

export function auditBodyPreview(request, preview) {
  if (!preview || preview.state !== "available") return { requestId: request.id, state: "unavailable", findings: [], shape: null };
  const text = String(preview.response || "");
  const findings = [];
  const add = (ruleId, severity, title, description, fixSuggestion) => findings.push({ ruleId, severity, confidence: "inferred", title, description, fixSuggestion });
  if (/stack trace|\bat\s+[\w.$]+\s*\([^\n]+:\d+:\d+\)|traceback \(most recent/i.test(text)) add("stack-trace", "high", "Response may expose a stack trace", "Debug call-site details were detected in the response preview.", "Return a stable public error shape and keep stack traces in protected server logs.");
  if (/sql syntax|postgresql|mysql|sqlite|ora-\d{4}|sequelize|prisma.*error/i.test(text)) add("database-error", "high", "Response may expose database details", "Database-specific error text was detected.", "Map database failures to generic client errors and log implementation details server-side.");
  let shape = null;
  try {
    const parsed = JSON.parse(text);
    const stats = inspectJson(parsed);
    shape = stats;
    if (stats.sensitiveKeys.length) add("sensitive-response-fields", "high", "Sensitive response field names detected", `Potentially sensitive keys: ${stats.sensitiveKeys.slice(0, 8).join(", ")}. Values were not retained.`, "Return only fields required by the client and remove secrets at serialization boundaries.");
    if (stats.depth > 8 || stats.keys > 300) add("response-overfetch", "medium", "Response shape may be excessive", `The JSON preview reached depth ${stats.depth} with ${stats.keys} keys.`, "Use projection, pagination, or a smaller API response contract.");
  } catch { /* Text responses still receive signature checks above. */ }
  return { requestId: request.id, state: "available", findings, shape };
}

function inspectJson(value) {
  let keys = 0; let depth = 0; const sensitiveKeys = new Set();
  const visit = (current, level) => {
    depth = Math.max(depth, level);
    if (!current || typeof current !== "object" || level > 20) return;
    for (const [key, nested] of Object.entries(current)) { keys += 1; if (SENSITIVE_NAME.test(key)) sensitiveKeys.add(key); visit(nested, level + 1); }
  };
  visit(value, 1);
  return { keys, depth, sensitiveKeys: [...sensitiveKeys] };
}
