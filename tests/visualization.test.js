import test from "node:test";
import assert from "node:assert/strict";
import { brushRangeToTimestamps, buildDependencyGraph, buildJourneyTimeline, buildNetworkSeries, buildSiteGraph, normalizeRouteUrl } from "../src/core/visualization.js";
import { diagnosticSession, requestFrom } from "./fixtures.js";

test("site graph normalizes query ordering and hashes and infers closest path ancestors", () => {
  const base = "https://app.example.com/";
  assert.equal(normalizeRouteUrl("/products?z=2&a=1#details", base), "https://app.example.com/products?a=1&z=2");
  const graph = buildSiteGraph([
    base,
    `${base}products`,
    `${base}products/42`,
    `${base}products/42/reviews`
  ], null, base);
  const products = graph.nodes.find((node) => node.path === "/products");
  const detail = graph.nodes.find((node) => node.path === "/products/42");
  const reviews = graph.nodes.find((node) => node.path === "/products/42/reviews");
  assert.equal(detail.parentId, products.id);
  assert.equal(reviews.parentId, detail.id);
  assert.ok(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.equal(graph.nodes.find((node) => node.kind === "site"), undefined);
});

test("site graph uses an explicit virtual root when the homepage was not discovered", () => {
  const graph = buildSiteGraph(["https://app.example.com/products", "https://app.example.com/cart"], null, "https://app.example.com/products");
  const root = graph.nodes.find((node) => node.kind === "site");
  assert.equal(root.label, "app.example.com");
  assert.ok(graph.nodes.filter((node) => node.kind === "route").every((node) => node.parentId === root.id));
});

test("site graph maps crawl states and route evidence", () => {
  const queue = ["https://app.example.com/", "https://app.example.com/products", "https://app.example.com/error"];
  const run = { routes: [
    { url: queue[0], score: 92, metrics: { transferSize: 1000 }, findings: [] },
    { url: queue[2], score: 30, status: "failed", metrics: {}, findings: [{ requestIds: ["request-1"] }] }
  ] };
  const graph = buildSiteGraph(queue, run, queue[0], queue[1]);
  assert.equal(graph.nodes.find((node) => node.url === queue[1]).state, "scanning");
  assert.equal(graph.nodes.find((node) => node.url === queue[2]).state, "failed");
  assert.deepEqual(graph.nodes.find((node) => node.url === queue[2]).requestIds, ["request-1"]);
});

test("dependency graph caps nodes and retains required ancestors", () => {
  const session = diagnosticSession();
  const base = Date.now();
  for (let index = 0; index < 190; index += 1) {
    session.requests.push(requestFrom({ url: `https://api.example.com/items/${index}`, startedAt: base + index * 5, time: index + 1 }));
  }
  const graph = buildDependencyGraph(session, 150);
  assert.ok(graph.nodes.length <= 150);
  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.ok(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
  assert.ok(graph.criticalChainIds.every((id) => ids.has(id)));
});

test("journey timeline orders all diagnostic lanes", () => {
  const session = diagnosticSession();
  const step = session.steps.find((item) => item.name === "Add to cart");
  step.navigationUrls.push("https://app.example.com/cart");
  const timeline = buildJourneyTimeline(session, step);
  assert.deepEqual(timeline.lanes, ["navigation", "api", "interaction", "longtask"]);
  assert.ok(timeline.events.some((event) => event.lane === "api" && event.requestId));
  assert.ok(timeline.events.some((event) => event.lane === "interaction"));
  assert.ok(timeline.events.some((event) => event.lane === "longtask"));
  assert.ok(timeline.events.every((event, index) => index === 0 || timeline.events[index - 1].start <= event.start));
});

test("network series and brush conversion are deterministic", () => {
  const session = diagnosticSession();
  const series = buildNetworkSeries(session.requests, 12);
  assert.equal(series.bins.length, 12);
  assert.equal(series.bins.reduce((sum, bin) => sum + bin.count, 0), session.requests.length);
  const range = brushRangeToTimestamps(0.75, 0.25, 1000, 5000);
  assert.deepEqual(range, { timeStart: 2000, timeEnd: 4000 });
});
