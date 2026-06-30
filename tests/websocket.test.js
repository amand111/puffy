import test from "node:test";
import assert from "node:assert/strict";
import { summarizeWebSockets, validateWebSocketSnapshot } from "../src/core/websocket.js";

test("validates and bounds untrusted WebSocket snapshots", () => {
  const snapshot = validateWebSocketSnapshot({ version: 1, installedAt: 1, observedAt: 2, connections: [{ id: "socket", url: "wss://example.com/live", state: "open", sentBytes: 10, receivedBytes: 20, messages: [{ id: "message", direction: "outgoing", at: 3, type: "text", bytes: 10, preview: "hello" }] }] });
  assert.equal(snapshot.connections[0].state, "open");
  assert.equal(snapshot.connections[0].messages[0].direction, "outgoing");
  assert.deepEqual(summarizeWebSockets(snapshot), { connections: 1, open: 1, messages: 1, sentBytes: 10, receivedBytes: 20 });
});

test("rejects malformed WebSocket snapshots", () => {
  assert.deepEqual(validateWebSocketSnapshot({ connections: "bad" }).connections, []);
});
