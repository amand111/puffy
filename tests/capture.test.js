import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest } from "../src/core/analysis.js";
import { DemoCaptureAdapter } from "../src/core/capture.js";

test("demo capture adapter follows the capture contract and loads bodies on demand", async () => {
  const requests = [];
  const handles = new Map();
  let telemetry = null;
  const adapter = new DemoCaptureAdapter({
    onRequest(entry, source, register) {
      const request = normalizeRequest(entry, "step-demo");
      requests.push(request);
      register(request.id);
      handles.set(request.id, source);
    },
    onTelemetry(sample) { telemetry = sample; }
  });
  await adapter.start();
  assert.ok(requests.length >= 10);
  assert.equal(handles.get(requests[0].id), "demo");
  assert.ok(telemetry.inp > 0);
  const service = requests.find((request) => request.requestPayloadBytes > 0);
  const body = await adapter.loadBodies(service.id);
  assert.equal(body.state, "available");
  assert.doesNotMatch(body.request, /secret/);
});
