import test from "node:test";
import assert from "node:assert/strict";
import { buildCurlCommand, buildGraphqlView, formatGraphql, parseBody } from "../src/core/inspector.js";
import { bodyViewerHtml, graphqlViewerHtml, webSocketMessageHtml } from "../src/ui/body-viewer.js";
import { requestFrom } from "./fixtures.js";

test("parses and formats JSON, form, GraphQL, and text bodies", () => {
  assert.equal(parseBody('{"ok":true}').formatted, '{\n  "ok": true\n}');
  assert.equal(parseBody("a=1&b=2").kind, "form");
  assert.equal(parseBody("query Viewer { viewer { id } }").kind, "graphql");
  assert.equal(parseBody("plain text").kind, "text");
});

test("builds a redacted reproducible cURL command", () => {
  const request = requestFrom({ method: "POST", url: "https://api.example.com/users?active=1", postData: '{"token":"secret","name":"Ada"}' });
  const curl = buildCurlCommand(request, '{"token":"secret","name":"Ada"}');
  assert.match(curl, /^curl 'https:\/\/api\.example\.com\/users\?active=1'/);
  assert.match(curl, /-X POST/);
  assert.doesNotMatch(curl, /authorization|secret/i);
  assert.match(curl, /\[redacted\]/);
});

test("builds a GraphQL operation, variables, data, and error view", () => {
  const request = requestFrom({ method: "POST", url: "https://api.example.com/graphql", postData: JSON.stringify({ operationName: "AddItem", query: "mutation AddItem($id: ID!) { addItem(id: $id) { id } }", variables: { id: "7" } }) });
  const view = buildGraphqlView(request, JSON.stringify({ operationName: "AddItem", query: "mutation AddItem($id: ID!) { addItem(id: $id) { id } }", variables: { id: "7" } }), JSON.stringify({ data: { addItem: null }, errors: [{ message: "Denied", path: ["addItem"] }] }));
  assert.equal(view.operation.kind, "mutation");
  assert.equal(view.variables.id, "7");
  assert.equal(view.errors[0].message, "Denied");
  assert.match(formatGraphql(view.query), /mutation AddItem/);
});

test("renders copyable JSON trees and specialized GraphQL inspectors", () => {
  const request = requestFrom({ method: "POST", url: "https://api.example.com/graphql", postData: JSON.stringify({ operationName: "Viewer", query: "query Viewer { viewer { id } }" }) });
  assert.match(bodyViewerHtml('{"ok":true}', { side: "response", requestId: request.id }), /data-copy-body="response"/);
  assert.match(bodyViewerHtml('{"ok":true}', { side: "response", requestId: request.id }), /class="json-tree"/);
  assert.match(graphqlViewerHtml(request, request.postData?.text || "", '{"data":{"viewer":{"id":"7"}}}'), /GraphQL operation/);
});

test("renders GraphQL WebSocket frames without request-router attributes", () => {
  const html = webSocketMessageHtml({ id: "frame-1", direction: "incoming", at: 10, type: "text", bytes: 42, preview: '{"id":"inventory","type":"next","payload":{"data":{"stock":4}}}' });
  assert.match(html, /GraphQL over WebSocket/);
  assert.match(html, /data-copy-ws-message="frame-1"/);
  assert.doesNotMatch(html, /data-request-id=/);
});
