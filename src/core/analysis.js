import {
  getDomain,
  getHeader,
  getPath,
  getPathname,
  hashString,
  isSameSite,
  makeId,
  normalizeEndpoint,
  parseGraphqlOperation,
  percentile,
  redactSecrets,
  sanitizeHeaders,
  stableRequestKey
} from "./utils.js";

export function inferResourceType(entry) {
  const mimeType = entry.response?.content?.mimeType || "";
  const url = entry.request?.url || "";
  const rawType = String(entry._resourceType || "").toLowerCase();
  if (["xhr", "fetch"].includes(rawType)) return "api";
  if (mimeType.includes("javascript") || /\.m?js(\?|$)/i.test(url)) return "script";
  if (mimeType.includes("css") || /\.css(\?|$)/i.test(url)) return "style";
  if (mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(url)) return "image";
  if (mimeType.includes("font") || /\.(woff2?|ttf|otf)(\?|$)/i.test(url)) return "font";
  if (mimeType.includes("json") || /\/api\/|graphql|\.json(\?|$)/i.test(url)) return "api";
  if (mimeType.includes("html")) return "document";
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) return "media";
  return rawType || "other";
}

export function inferCallKind(entry, type) {
  const rawType = String(entry._resourceType || "").toLowerCase();
  if (rawType === "fetch") return "fetch";
  if (rawType === "xhr") return "xhr";
  const requestedWith = getHeader(entry.request?.headers || [], "x-requested-with");
  const accept = getHeader(entry.request?.headers || [], "accept");
  if (/xmlhttprequest/i.test(requestedWith)) return "xhr";
  if (type === "api" || /application\/json|graphql/i.test(accept)) return "api";
  return type;
}

function extractInitiator(entry) {
  const initiator = entry._initiator;
  if (!initiator) return null;
  const frame = initiator.stack?.callFrames?.[0] || initiator.stack?.parent?.callFrames?.[0];
  return {
    type: initiator.type || "unknown",
    url: initiator.url || frame?.url || "",
    lineNumber: Number(initiator.lineNumber ?? frame?.lineNumber ?? -1),
    columnNumber: Number(initiator.columnNumber ?? frame?.columnNumber ?? -1)
  };
}

export function normalizeRequest(entry, stepId = null) {
  const request = entry.request || {};
  const response = entry.response || {};
  const postText = String(request.postData?.text || "");
  const type = inferResourceType(entry);
  const transferSize = Math.max(0, Number(response._transferSize || response.bodySize || response.content?.size || 0));
  const payloadBytes = postText ? new Blob([postText]).size : 0;
  const url = request.url || "";
  const graphql = parseGraphqlOperation(url, postText);
  const queryParams = (request.queryString || []).map((item) => ({
    name: String(item.name || ""),
    value: /token|key|secret|password|auth/i.test(item.name || "") ? "[redacted]" : String(item.value || "")
  }));
  const timings = entry.timings || {};
  const cookieMetadata = (response.headers || []).filter((header) => String(header.name).toLowerCase() === "set-cookie").map((header) => parseCookieMetadata(header.value));
  return {
    id: makeId("request"),
    dedupeKey: stableRequestKey(entry),
    startedDateTime: entry.startedDateTime || new Date().toISOString(),
    startedAtLabel: new Date(entry.startedDateTime || Date.now()).toLocaleTimeString(),
    method: request.method || "GET",
    url,
    domain: getDomain(url),
    path: getPath(url),
    endpointTemplate: normalizeEndpoint(url),
    status: Number(response.status || 0),
    statusText: response.statusText || "",
    mimeType: response.content?.mimeType || "",
    type,
    callKind: inferCallKind(entry, type),
    time: Math.max(0, Number(entry.time || 0)),
    transferSize,
    encodedSize: Math.max(0, Number(response.content?.compression ? response.content.size - response.content.compression : response.content?.size || 0)),
    decodedSize: Math.max(0, Number(response.content?.size || 0)),
    requestPayloadBytes: payloadBytes,
    hasRequestBody: Boolean(postText),
    responseBodyBytes: Math.max(0, Number(response.content?.size || response.bodySize || 0)),
    dataPassingBytes: transferSize + payloadBytes,
    queryParamCount: queryParams.length,
    queryParams,
    cacheControl: getHeader(response.headers, "cache-control"),
    contentEncoding: getHeader(response.headers, "content-encoding"),
    contentType: getHeader(response.headers, "content-type"),
    serverTiming: getHeader(response.headers, "server-timing"),
    requestHeaders: sanitizeHeaders(request.headers),
    responseHeaders: sanitizeHeaders(response.headers),
    cookieMetadata,
    bodyFingerprint: postText ? hashString(redactSecrets(postText, 50000)) : "",
    bodyState: typeof entry.getContent === "function" || postText ? "available" : "unavailable",
    graphql,
    priority: entry._priority || "",
    protocol: response.httpVersion || request.httpVersion || "",
    serverIPAddress: entry.serverIPAddress || "",
    connection: entry.connection || "",
    redirectURL: response.redirectURL || "",
    fromCache: Boolean(response._fromDiskCache || response._fromMemoryCache || response.status === 304),
    initiator: extractInitiator(entry),
    resourceTiming: null,
    stepId,
    timings: {
      blocked: timings.blocked,
      dns: timings.dns,
      connect: timings.connect,
      ssl: timings.ssl,
      send: timings.send,
      wait: timings.wait,
      receive: timings.receive
    }
  };
}

function parseCookieMetadata(value = "") {
  const parts = String(value).split(";").map((part) => part.trim());
  const name = parts[0]?.split("=")[0] || "cookie";
  const attributes = new Map(parts.slice(1).map((part) => {
    const [key, ...rest] = part.split("=");
    return [key.toLowerCase(), rest.join("=") || true];
  }));
  return {
    name,
    secure: attributes.has("secure"),
    httpOnly: attributes.has("httponly"),
    sameSite: String(attributes.get("samesite") || ""),
    domain: attributes.has("domain"),
    path: String(attributes.get("path") || ""),
    hostPrefix: name.startsWith("__Host-"),
    securePrefix: name.startsWith("__Secure-")
  };
}

export function deduplicateRequests(requests) {
  const seen = new Map();
  const unique = [];
  for (const request of requests) {
    const key = request.dedupeKey || `${request.method}|${request.url}|${request.startedDateTime}`;
    if (!seen.has(key)) {
      seen.set(key, request);
      unique.push(request);
      continue;
    }
    const existing = seen.get(key);
    if (!existing.initiator && request.initiator) existing.initiator = request.initiator;
    if (existing.bodyState === "unavailable" && request.bodyState === "available") existing.bodyState = "available";
  }
  return unique;
}

export function isServiceRequest(request) {
  return ["fetch", "xhr", "api"].includes(request.callKind) || request.type === "api";
}

export function associateResourceTimings(session) {
  const timingsByUrl = new Map();
  for (const timing of session.telemetry?.resources || []) {
    if (!timingsByUrl.has(timing.name)) timingsByUrl.set(timing.name, []);
    timingsByUrl.get(timing.name).push(timing);
  }
  for (const request of session.requests) {
    const candidates = timingsByUrl.get(request.url) || [];
    if (!candidates.length) continue;
    const started = new Date(request.startedDateTime).getTime();
    request.resourceTiming = [...candidates].sort((a, b) => Math.abs(a.absoluteStart - started) - Math.abs(b.absoluteStart - started))[0];
  }
}

export function analyzeServices(session) {
  const origin = getDomain(session.url || session.pageMetrics?.url);
  const groups = new Map();
  for (const request of session.requests.filter(isServiceRequest)) {
    if (!groups.has(request.domain)) groups.set(request.domain, []);
    groups.get(request.domain).push(request);
  }
  return [...groups.entries()].map(([domain, requests]) => {
    const times = requests.map((request) => request.time);
    const errors = requests.filter((request) => request.status >= 400).length;
    const totalTime = times.reduce((sum, value) => sum + value, 0);
    const service = {
      domain,
      requests: [...requests].sort((a, b) => b.time - a.time),
      count: requests.length,
      errors,
      totalTime,
      averageTime: requests.length ? totalTime / requests.length : 0,
      p95: percentile(times, 95),
      transferSize: requests.reduce((sum, request) => sum + request.transferSize, 0),
      payloadBytes: requests.reduce((sum, request) => sum + request.requestPayloadBytes, 0),
      dataPassing: requests.reduce((sum, request) => sum + request.dataPassingBytes, 0),
      endpoints: new Set(requests.map((request) => request.endpointTemplate)).size,
      methods: [...new Set(requests.map((request) => request.method))],
      thirdParty: !isSameSite(domain, origin),
      purpose: inferServicePurpose(domain, requests, origin)
    };
    service.health = errors ? "bad" : service.p95 > 1000 ? "warn" : "good";
    service.assessment = service.errors
      ? `${service.errors} failed call${service.errors === 1 ? "" : "s"}; inspect the first failure and retry behavior.`
      : service.p95 > 1000
        ? `The p95 latency is ${Math.round(service.p95)} ms; server wait time and serial dependencies deserve review.`
        : `No reliability or latency threshold was crossed in this capture.`;
    return service;
  }).sort((a, b) => b.errors - a.errors || b.totalTime - a.totalTime);
}

function inferServicePurpose(domain, requests, origin) {
  const sample = `${domain} ${requests.map((request) => request.path).join(" ")}`.toLowerCase();
  const rules = [
    [/stripe|paypal|checkout|razorpay|adyen|braintree/, "Payments"],
    [/auth0|okta|clerk|cognito|firebaseauth|\/oauth|\/login|\/session/, "Authentication"],
    [/segment|analytics|google-analytics|googletagmanager|mixpanel|amplitude|hotjar|clarity/, "Analytics"],
    [/sentry|bugsnag|datadog|newrelic|rollbar|logrocket/, "Monitoring"],
    [/algolia|elastic|\/search/, "Search"],
    [/graphql/, "GraphQL API"]
  ];
  const match = rules.find(([pattern]) => pattern.test(sample));
  if (match) return match[1];
  return isSameSite(domain, origin) ? "First-party API" : "External API";
}

export function detectPatterns(session) {
  const requests = session.requests;
  const serviceRequests = requests.filter(isServiceRequest);
  const patterns = [];
  const groups = groupBy(serviceRequests, (request) => `${request.stepId || "none"}|${request.method}|${request.domain}|${request.endpointTemplate}|${request.bodyFingerprint}`);

  for (const grouped of groups.values()) {
    if (grouped.length < 2) continue;
    const failed = grouped.filter((request) => request.status >= 400);
    const kind = failed.length ? "retry" : "duplicate";
    patterns.push(makePattern(kind, kind === "retry" ? "Retry sequence" : "Duplicate calls", grouped, `${grouped.length} ${grouped[0].method} calls hit ${grouped[0].endpointTemplate} in one journey step.`));
  }

  const endpointGroups = groupBy(serviceRequests, (request) => `${request.stepId || "none"}|${request.method}|${request.domain}|${request.endpointTemplate}`);
  for (const grouped of endpointGroups.values()) {
    const rawPaths = new Set(grouped.map((request) => request.path.split("?")[0]));
    if (grouped.length >= 5 && rawPaths.size >= 3) {
      patterns.push(makePattern("n-plus-one", "Possible N+1 calls", grouped, `${grouped.length} calls targeted ${grouped[0].endpointTemplate} with ${rawPaths.size} resource identifiers.`));
    }
    const sizes = grouped.map((request) => request.requestPayloadBytes).filter(Boolean);
    if (sizes.length >= 2 && Math.max(...sizes) - Math.min(...sizes) > 10_000 && Math.max(...sizes) > Math.min(...sizes) * 2) {
      patterns.push(makePattern("payload-growth", "Payload growth", grouped, `Payload size grew from ${Math.min(...sizes)} to ${Math.max(...sizes)} bytes for ${grouped[0].endpointTemplate}.`));
    }
  }

  const stepGroups = groupBy(serviceRequests, (request) => request.stepId || "none");
  for (const grouped of stepGroups.values()) {
    const sorted = [...grouped].sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));
    let chain = [];
    for (const request of sorted) {
      const previous = chain.at(-1);
      if (!previous) {
        chain = [request];
        continue;
      }
      const previousEnd = new Date(previous.startedDateTime).getTime() + previous.time;
      const gap = new Date(request.startedDateTime).getTime() - previousEnd;
      if (gap >= -20 && gap <= 500) chain.push(request);
      else {
        if (chain.length >= 3) patterns.push(makePattern("serial-chain", "Serial API chain", chain, `${chain.length} service calls ran sequentially instead of overlapping.`));
        chain = [request];
      }
    }
    if (chain.length >= 3) patterns.push(makePattern("serial-chain", "Serial API chain", chain, `${chain.length} service calls ran sequentially instead of overlapping.`));
  }

  for (const preflight of requests.filter((request) => request.method === "OPTIONS")) {
    const started = new Date(preflight.startedDateTime).getTime();
    const match = requests.find((request) => request.method !== "OPTIONS" && request.domain === preflight.domain && request.endpointTemplate === preflight.endpointTemplate && new Date(request.startedDateTime).getTime() >= started && new Date(request.startedDateTime).getTime() - started < 3000);
    if (match) patterns.push(makePattern("preflight", "CORS preflight overhead", [preflight, match], `The preflight added ${Math.round(preflight.time)} ms before ${match.method} ${match.endpointTemplate}.`));
  }

  for (const request of requests.filter((item) => item.status >= 300 && item.status < 400 && item.redirectURL)) {
    const target = requests.find((candidate) => candidate.url === request.redirectURL);
    patterns.push(makePattern("redirect", "Redirect chain", target ? [request, target] : [request], `${request.status} redirected ${getPathname(request.url)} to ${request.redirectURL}.`));
  }
  return patterns;
}

function makePattern(type, title, requests, detail) {
  return { id: makeId("pattern"), type, title, detail, severity: ["retry", "n-plus-one", "serial-chain"].includes(type) ? "medium" : "low", requestIds: requests.map((request) => request.id), stepId: requests[0]?.stepId || null };
}

function groupBy(items, keyFunction) {
  const map = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function buildDependencies(session) {
  const requests = [...session.requests].sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));
  const byUrl = new Map(requests.map((request) => [request.url, request]));
  const edges = [];
  for (const request of requests) {
    let parent = null;
    let confidence = "inferred";
    if (request.initiator?.url && byUrl.has(request.initiator.url)) {
      parent = byUrl.get(request.initiator.url);
      confidence = "exact";
    } else if (request.initiator?.type === "parser") {
      parent = requests.find((candidate) => candidate.type === "document") || null;
      confidence = parent ? "exact" : "inferred";
    } else {
      const start = new Date(request.startedDateTime).getTime();
      parent = [...requests].reverse().find((candidate) => {
        if (candidate.id === request.id) return false;
        const candidateStart = new Date(candidate.startedDateTime).getTime();
        const candidateEnd = candidateStart + candidate.time;
        return candidateStart <= start && start - candidateEnd <= 1000 && ["document", "script", "api"].includes(candidate.type);
      }) || null;
    }
    if (parent) edges.push({ id: makeId("edge"), from: parent.id, to: request.id, confidence, reason: confidence === "exact" ? request.initiator?.type || "initiator" : "timing proximity" });
  }
  const parentByChild = new Map(edges.map((edge) => [edge.to, edge]));
  const weighted = requests.map((request) => {
    const chain = [];
    const seen = new Set();
    let current = request;
    while (current && !seen.has(current.id)) {
      chain.unshift(current);
      seen.add(current.id);
      const edge = parentByChild.get(current.id);
      current = edge ? requests.find((candidate) => candidate.id === edge.from) : null;
    }
    return { request, chain, weight: chain.reduce((sum, item) => sum + item.time, 0) };
  }).sort((a, b) => b.weight - a.weight);
  return { edges, criticalChain: weighted[0]?.chain || [], criticalWeight: weighted[0]?.weight || 0 };
}

export function summarize(session) {
  const requests = session.requests || [];
  const services = analyzeServices(session);
  const totalTime = requests.reduce((sum, request) => sum + request.time, 0);
  const transferSize = requests.reduce((sum, request) => sum + request.transferSize, 0);
  const errors = requests.filter((request) => request.status >= 400).length;
  const origin = getDomain(session.url || session.pageMetrics?.url);
  const serviceP95 = percentile(requests.filter(isServiceRequest).map((request) => request.time), 95);
  const summary = {
    requestCount: requests.length,
    totalTime,
    transferSize,
    dataPassing: requests.reduce((sum, request) => sum + request.dataPassingBytes, 0),
    errors,
    thirdParty: requests.filter((request) => !isSameSite(request.domain, origin)).length,
    services,
    serviceP95,
    slowest: [...requests].sort((a, b) => b.time - a.time)[0] || null,
    largest: [...requests].sort((a, b) => b.transferSize - a.transferSize)[0] || null,
    longTaskTime: (session.telemetry?.longTasks || []).reduce((sum, task) => sum + task.duration, 0),
    inp: Number(session.telemetry?.inp || 0)
  };
  summary.score = scoreSession(session, summary);
  return summary;
}

export function summarizeStep(session, step) {
  const requests = session.requests.filter((request) => request.stepId === step.id);
  const longTasks = session.telemetry.longTasks.filter((task) => step.longTaskIds.includes(task.id));
  const interactions = session.telemetry.interactions.filter((interaction) => step.interactionIds.includes(interaction.id));
  return {
    requestCount: requests.length,
    transferSize: requests.reduce((sum, request) => sum + request.transferSize, 0),
    totalTime: requests.reduce((sum, request) => sum + request.time, 0),
    errors: requests.filter((request) => request.status >= 400).length,
    services: new Set(requests.filter(isServiceRequest).map((request) => request.domain)).size,
    longTasks: longTasks.length,
    longTaskTime: longTasks.reduce((sum, task) => sum + task.duration, 0),
    interactions: interactions.length,
    maxInteraction: Math.max(0, ...interactions.map((interaction) => interaction.duration)),
    requests
  };
}

function scoreSession(session, summary) {
  const metrics = session.pageMetrics || {};
  let score = 100;
  const load = metrics.loadEventEnd || metrics.domComplete || 0;
  score -= Math.min(18, Math.max(0, load - 2500) / 300);
  score -= Math.min(18, Math.max(0, summary.transferSize - 1_500_000) / 180_000);
  score -= Math.min(15, Math.max(0, summary.requestCount - 70) / 5);
  score -= Math.min(18, summary.errors * 5);
  score -= Math.min(8, Math.max(0, summary.serviceP95 - 800) / 250);
  score -= Math.min(10, Math.max(0, summary.inp - 200) / 80);
  score -= Math.min(8, Math.max(0, summary.longTaskTime - 200) / 200);
  if (session.telemetry?.lcp > 2500) score -= Math.min(15, (session.telemetry.lcp - 2500) / 300);
  if (session.telemetry?.cls > 0.1) score -= Math.min(8, (session.telemetry.cls - 0.1) * 35);
  return Math.max(0, Math.round(score));
}

export function buildFindings(session) {
  const summary = summarize(session);
  const patterns = detectPatterns(session);
  const findings = [];
  const add = (severity, category, title, evidence, recommendation, evidenceIds = []) => findings.push({ id: makeId("finding"), severity, category, title, evidence, recommendation, evidenceIds });
  const failed = session.requests.filter((request) => request.status >= 400);
  const slow = session.requests.filter((request) => request.time > 1000).sort((a, b) => b.time - a.time);
  if (failed.length) add("high", "Reliability", "Failing network calls", `${failed.length} call(s) failed; first was ${failed[0].status} ${getPathname(failed[0].url)}.`, "Fix failures before optimizing downstream timings.", failed.map((request) => request.id));
  if (session.telemetry?.inp > 500) add("high", "Responsiveness", "Slow interaction latency", `The INP-style interaction latency reached ${Math.round(session.telemetry.inp)} ms.`, "Inspect the longest interaction and nearby long tasks.", session.telemetry.interactions.filter((item) => item.duration >= session.telemetry.inp).map((item) => item.id));
  if (slow.length) add("medium", "Latency", "Slow calls", slow.slice(0, 4).map((request) => `${Math.round(request.time)} ms ${getPathname(request.url)}`).join("; "), "Start with server wait time and serial dependency chains.", slow.slice(0, 4).map((request) => request.id));
  if (summary.longTaskTime > 200) add("medium", "Main thread", "Long main-thread work", `${session.telemetry.longTasks.length} long task(s) blocked the page for ${Math.round(summary.longTaskTime)} ms.`, "Split expensive work and defer non-critical JavaScript.", session.telemetry.longTasks.map((task) => task.id));
  for (const pattern of patterns) add(pattern.severity, "Request pattern", pattern.title, pattern.detail, recommendationForPattern(pattern.type), pattern.requestIds);
  if (!findings.length && session.requests.length) add("low", "Summary", "No major threshold crossed", "This capture stayed within Puffy's current thresholds.", "Record named interactions and compare another run before concluding the page is stable.");
  return findings;
}

function recommendationForPattern(type) {
  const recommendations = {
    retry: "Fix the first failure and cap retries with backoff and a clear terminal state.",
    duplicate: "Share or cache the result so identical calls are not repeated within one step.",
    "n-plus-one": "Replace per-item requests with a batch endpoint or expanded server response.",
    "serial-chain": "Parallelize independent calls or consolidate the dependency chain server-side.",
    preflight: "Reuse connections and simplify non-simple cross-origin requests where safe.",
    redirect: "Link directly to the final resource and remove avoidable redirect hops.",
    "payload-growth": "Review repeated context and unused request fields."
  };
  return recommendations[type] || "Review whether this request pattern is intentional.";
}

export function buildNarrative(session) {
  const summary = summarize(session);
  const findings = buildFindings(session);
  if (!summary.requestCount) return { confidence: "Waiting for data", tone: "neutral", paragraphs: ["Capture a page load or named journey step to generate analysis."], actions: [] };
  const label = summary.score >= 90 ? "excellent" : summary.score >= 75 ? "healthy" : summary.score >= 55 ? "needs work" : "poor";
  const paragraphs = [`This capture looks <strong>${label}</strong> at ${summary.score}/100. It contains ${summary.requestCount} requests across ${session.steps.length} journey step${session.steps.length === 1 ? "" : "s"}, with ${Math.round(summary.transferSize / 1024)} KB transferred.`];
  const top = findings.find((finding) => finding.severity === "high") || findings.find((finding) => finding.severity === "medium");
  if (top) paragraphs.push(`The clearest issue is <strong>${top.title.toLowerCase()}</strong>. ${top.evidence}`);
  const stepSummaries = session.steps.map((step) => ({ step, summary: summarizeStep(session, step) })).sort((a, b) => b.summary.totalTime - a.summary.totalTime);
  const heaviest = stepSummaries[0];
  if (heaviest) paragraphs.push(`<strong>${heaviest.step.name}</strong> was the heaviest step with ${heaviest.summary.requestCount} calls, ${Math.round(heaviest.summary.transferSize / 1024)} KB transferred, and ${heaviest.summary.longTasks} long task(s).`);
  return { confidence: session.steps.length > 1 ? "Journey evidence" : "Page-load evidence", tone: top?.severity === "high" ? "bad" : top ? "warn" : "good", paragraphs, actions: findings.slice(0, 3).map((finding) => finding.recommendation) };
}

export function compareCaptures(first, second) {
  const left = summarize(first.session || first);
  const right = summarize(second.session || second);
  const metric = (key, label, lowerIsBetter = true) => {
    const before = Number(left[key] || 0);
    const after = Number(right[key] || 0);
    const delta = after - before;
    const percent = before ? delta / before * 100 : 0;
    return { key, label, before, after, delta, percent, improved: lowerIsBetter ? delta < 0 : delta > 0 };
  };
  return {
    metrics: [metric("score", "Health score", false), metric("requestCount", "Requests"), metric("transferSize", "Transferred"), metric("errors", "Failures"), metric("serviceP95", "Service p95"), metric("inp", "Interaction latency"), metric("longTaskTime", "Long-task time")],
    addedEndpoints: endpointDifference(second.session || second, first.session || first),
    removedEndpoints: endpointDifference(first.session || first, second.session || second)
  };
}

function endpointDifference(source, other) {
  const otherKeys = new Set(other.requests.map((request) => `${request.method} ${request.domain}${request.endpointTemplate}`));
  return [...new Set(source.requests.map((request) => `${request.method} ${request.domain}${request.endpointTemplate}`).filter((key) => !otherKeys.has(key)))];
}
