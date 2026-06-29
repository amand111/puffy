import { normalizeRequest } from "../src/core/analysis.js";
import { assignRequestToStep, createSession, mergeTelemetry, startStep, stopActiveStep } from "../src/core/model.js";

export function harEntry({ method = "GET", url, status = 200, startedAt = Date.now(), time = 100, bytes = 1000, resourceType = "xhr", postData = "", initiator = null, redirectURL = "" }) {
  return {
    startedDateTime: new Date(startedAt).toISOString(),
    time,
    _resourceType: resourceType,
    _priority: "High",
    _initiator: initiator,
    request: {
      method,
      url,
      httpVersion: "h2",
      headers: [{ name: "accept", value: "application/json" }, { name: "authorization", value: "Bearer secret" }],
      queryString: [],
      postData: postData ? { text: postData } : undefined
    },
    response: {
      status,
      statusText: status >= 400 ? "Error" : "OK",
      httpVersion: "h2",
      headers: [{ name: "content-type", value: "application/json" }, { name: "set-cookie", value: "secret=1" }],
      content: { mimeType: resourceType === "script" ? "application/javascript" : "application/json", size: bytes },
      _transferSize: bytes,
      redirectURL
    },
    timings: { blocked: 2, dns: 5, connect: 10, ssl: 8, send: 2, wait: time * 0.7, receive: time * 0.2 },
    serverIPAddress: "203.0.113.10"
  };
}

export function requestFrom(options, stepId = "step-test") {
  return normalizeRequest(harEntry(options), stepId);
}

export function diagnosticSession() {
  const base = Date.now() - 10_000;
  const session = createSession("Fixture", new Date(base).toISOString());
  session.url = "https://app.example.com/products";
  session.title = "Fixture app";
  const initial = session.steps[0];
  initial.endedAt = new Date(base + 2500).toISOString();
  initial.status = "complete";
  session.activeStepId = null;
  const step = startStep(session, "Add to cart", new Date(base + 3000).toISOString());
  const specs = [
    { url: "https://app.example.com/", resourceType: "document", startedAt: base, time: 400, initiator: { type: "parser", url: "" } },
    { url: "https://cdn.example.com/app.js", resourceType: "script", startedAt: base + 300, time: 500, initiator: { type: "parser", url: "https://app.example.com/" } },
    ...[1, 2, 3, 4, 5].map((id, index) => ({ url: `https://api.example.com/users/${id}`, startedAt: base + 3100 + index * 250, time: 200, initiator: { type: "script", url: "https://cdn.example.com/app.js" } })),
    { method: "POST", url: "https://api.example.com/graphql", status: 500, startedAt: base + 4500, time: 300, postData: JSON.stringify({ operationName: "AddItem", query: "mutation AddItem { addItem { id } }", token: "secret" }) },
    { method: "POST", url: "https://api.example.com/graphql", status: 200, startedAt: base + 4850, time: 250, postData: JSON.stringify({ operationName: "AddItem", query: "mutation AddItem { addItem { id } }", token: "secret" }) },
    { method: "OPTIONS", url: "https://pay.example.net/charge", status: 204, startedAt: base + 5200, time: 150, resourceType: "preflight" },
    { method: "POST", url: "https://pay.example.net/charge", status: 200, startedAt: base + 5400, time: 350, postData: "amount=100" }
  ];
  session.requests = specs.map((spec) => {
    const request = requestFrom(spec, spec.startedAt < base + 3000 ? initial.id : step.id);
    const target = spec.startedAt < base + 3000 ? initial : step;
    target.requestIds.push(request.id);
    return request;
  });
  stopActiveStep(session, new Date(base + 7000).toISOString());
  mergeTelemetry(session, {
    observedAt: base + 7000,
    url: session.url,
    title: session.title,
    navigation: { ttfb: 250, domInteractive: 900, domComplete: 1800, loadEventEnd: 2100 },
    lcp: 1900,
    cls: 0.05,
    fcp: 700,
    inp: 360,
    interactions: [{ id: "interaction-1", kind: "interaction", absoluteStart: base + 6000, duration: 360, name: "click" }],
    longTasks: [{ id: "longtask-1", kind: "longtask", absoluteStart: base + 5800, duration: 180, name: "long task", attribution: ["app.js"] }],
    resources: []
  });
  return session;
}
