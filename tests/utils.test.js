import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEndpoint, parseGraphqlOperation, redactSecrets, sanitizeHeaders } from "../src/core/utils.js";

test("normalizes common REST identifiers without changing stable segments", () => {
  assert.equal(normalizeEndpoint("https://api.example.com/users/123/orders/550e8400-e29b-41d4-a716-446655440000?full=1"), "/users/:id/orders/:uuid");
  assert.equal(normalizeEndpoint("https://api.example.com/v2/products/search"), "/v2/products/search");
});

test("redacts sensitive headers and payload fields", () => {
  assert.deepEqual(sanitizeHeaders([{ name: "Authorization", value: "Bearer abc" }, { name: "accept", value: "application/json" }]), [{ name: "Authorization", value: "[redacted]" }, { name: "accept", value: "application/json" }]);
  assert.match(redactSecrets('{"password":"hunter2","token":"abc"}'), /\[redacted\]/);
  assert.doesNotMatch(redactSecrets('{"password":"hunter2"}'), /hunter2/);
});

test("extracts GraphQL operation metadata without retaining the full body", () => {
  assert.deepEqual(parseGraphqlOperation("https://api.example.com/graphql", JSON.stringify({ operationName: "Checkout", query: "mutation Checkout { checkout { id } }" })), { name: "Checkout", kind: "mutation" });
  assert.equal(parseGraphqlOperation("https://api.example.com/users", ""), null);
});
