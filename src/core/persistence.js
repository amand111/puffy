import { makeId } from "./utils.js";
import { SCHEMA_VERSION, migrateSession, serializableSession, validateCapture } from "./model.js";

const STORAGE_KEY = "puffy.savedCaptures.v4";
const LEGACY_STORAGE_KEY = "puffy.savedCaptures.v3";

export class StorageQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageQuotaError";
  }
}

export class ExtensionContextInvalidatedError extends Error {
  constructor() {
    super("Puffy was reloaded while this DevTools panel was open. Reload the panel or reopen DevTools to reconnect.");
    this.name = "ExtensionContextInvalidatedError";
  }
}

export function isExtensionContextInvalidatedError(error) {
  return error instanceof ExtensionContextInvalidatedError || /extension context invalidated|context invalidated/i.test(String(error?.message || error));
}

export class SavedCaptureStore {
  constructor(storageArea) {
    this.storage = storageArea;
  }

  async list() {
    const result = await this.callStorage("get", STORAGE_KEY);
    if (Array.isArray(result?.[STORAGE_KEY])) return result[STORAGE_KEY].filter((capture) => validateCapture(capture.session));
    const legacy = await this.callStorage("get", LEGACY_STORAGE_KEY);
    if (!Array.isArray(legacy?.[LEGACY_STORAGE_KEY])) return [];
    const migrated = legacy[LEGACY_STORAGE_KEY].map((capture) => ({ ...capture, schemaVersion: SCHEMA_VERSION, session: migrateSession(capture.session) })).filter((capture) => capture.session);
    if (migrated.length) await this.write(migrated);
    return migrated;
  }

  async save(session, { name, note = "" }) {
    const captures = await this.list();
    const capture = {
      schemaVersion: SCHEMA_VERSION,
      id: makeId("capture"),
      name: String(name || "").trim(),
      note: String(note || "").trim(),
      savedAt: new Date().toISOString(),
      session: serializableSession(session)
    };
    if (!capture.name) throw new Error("Capture name is required.");
    await this.write([...captures, capture]);
    return capture;
  }

  async rename(id, name) {
    const nextName = String(name || "").trim();
    if (!nextName) throw new Error("Capture name is required.");
    const captures = await this.list();
    const capture = captures.find((item) => item.id === id);
    if (!capture) throw new Error("Saved capture not found.");
    capture.name = nextName;
    await this.write(captures);
    return capture;
  }

  async remove(id) {
    const captures = await this.list();
    await this.write(captures.filter((capture) => capture.id !== id));
  }

  async usage() {
    const bytes = typeof this.storage.getBytesInUse === "function" ? await this.callStorage("getBytesInUse", STORAGE_KEY) : new Blob([JSON.stringify(await this.list())]).size;
    const quota = Number(this.storage.QUOTA_BYTES || globalThis.chrome?.storage?.local?.QUOTA_BYTES || 10 * 1024 * 1024);
    return { bytes, quota, ratio: quota ? bytes / quota : 0 };
  }

  async write(captures) {
    const payload = { [STORAGE_KEY]: captures };
    const bytes = new Blob([JSON.stringify(payload)]).size;
    const quota = Number(this.storage.QUOTA_BYTES || globalThis.chrome?.storage?.local?.QUOTA_BYTES || 10 * 1024 * 1024);
    if (bytes > quota) throw new StorageQuotaError(`Saving this capture would exceed the local ${Math.round(quota / 1024 / 1024)} MB quota.`);
    try {
      await this.callStorage("set", payload);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) throw error;
      if (/quota/i.test(String(error?.message || error))) throw new StorageQuotaError("Chrome rejected the save because local extension storage is full.");
      throw error;
    }
  }

  async callStorage(method, ...args) {
    try {
      if (!this.storage || typeof this.storage[method] !== "function") throw new ExtensionContextInvalidatedError();
      return await this.storage[method](...args);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error) || (globalThis.chrome?.runtime && !globalThis.chrome.runtime.id)) throw new ExtensionContextInvalidatedError();
      throw error;
    }
  }
}

export class MemoryStorageArea {
  constructor() {
    this.data = {};
    this.QUOTA_BYTES = 10 * 1024 * 1024;
  }

  async get(key) {
    return { [key]: this.data[key] };
  }

  async set(payload) {
    Object.assign(this.data, payload);
  }

  async getBytesInUse(key) {
    return new Blob([JSON.stringify(this.data[key] || [])]).size;
  }
}
