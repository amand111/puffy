import test from "node:test";
import assert from "node:assert/strict";
import { assignRequestToStep, createSession, serializableSession, startStep, stopActiveStep } from "../src/core/model.js";
import { MemoryStorageArea, SavedCaptureStore, StorageQuotaError } from "../src/core/persistence.js";
import { requestFrom } from "./fixtures.js";

test("starts and stops named steps and attributes requests", () => {
  const session = createSession();
  stopActiveStep(session);
  const step = startStep(session, "Search");
  const request = requestFrom({ url: "https://api.example.com/search?q=shoe" });
  assignRequestToStep(session, request);
  session.requests.push(request);
  assert.equal(request.stepId, step.id);
  assert.deepEqual(step.requestIds, [request.id]);
  stopActiveStep(session);
  assert.equal(step.status, "complete");
});

test("serializable sessions remove transient body fields", () => {
  const session = createSession();
  const request = requestFrom({ url: "https://api.example.com/private" });
  request.postData = "secret";
  request.responsePreview = "secret";
  session.requests.push(request);
  const saved = serializableSession(session);
  assert.equal(saved.requests[0].postData, undefined);
  assert.equal(saved.requests[0].responsePreview, undefined);
  assert.equal(saved.activeStepId, undefined);
});

test("saves, renames, and deletes explicitly named captures", async () => {
  const storage = new MemoryStorageArea();
  const store = new SavedCaptureStore(storage);
  const session = createSession();
  const saved = await store.save(session, { name: "Before release", note: "main branch" });
  const reopenedStore = new SavedCaptureStore(storage);
  assert.equal((await reopenedStore.list()).length, 1);
  await store.rename(saved.id, "After release");
  assert.equal((await store.list())[0].name, "After release");
  await store.remove(saved.id);
  assert.equal((await store.list()).length, 0);
});

test("rejects saves that exceed quota without deleting existing captures", async () => {
  const storage = new MemoryStorageArea();
  storage.QUOTA_BYTES = 500;
  const store = new SavedCaptureStore(storage);
  const session = createSession();
  session.notes.push("x".repeat(1000));
  await assert.rejects(() => store.save(session, { name: "Too large" }), StorageQuotaError);
  assert.equal((await store.list()).length, 0);
});
