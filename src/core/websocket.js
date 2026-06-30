export const WEBSOCKET_CAPTURE_EXPRESSION = `(() => {
  if (window.__puffyWebSocketCapture?.version === 1) return true;
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return false;
  const capture = { version: 1, installedAt: Date.now(), sequence: 0, connections: [] };
  const redact = (value) => String(value ?? '')
    .replace(/(["']?(?:token|access_token|refresh_token|api_key|apikey|password|secret|authorization)["']?\\s*[:=]\\s*["']?)[^"'&\\s,}]+/gi, '$1[redacted]')
    .replace(/Bearer\\s+[A-Za-z0-9._~+\\/-]+=*/gi, 'Bearer [redacted]')
    .slice(0, 12000);
  const describe = (data) => {
    if (typeof data === 'string') return { type: 'text', bytes: new TextEncoder().encode(data).byteLength, preview: redact(data) };
    if (data instanceof ArrayBuffer) return { type: 'arraybuffer', bytes: data.byteLength, preview: '[binary ArrayBuffer]' };
    if (ArrayBuffer.isView(data)) return { type: 'binary', bytes: data.byteLength, preview: '[binary typed array]' };
    if (typeof Blob !== 'undefined' && data instanceof Blob) return { type: 'blob', bytes: data.size, preview: '[binary Blob]' };
    return { type: typeof data, bytes: 0, preview: redact(data) };
  };
  const snapshot = () => ({
    version: 1,
    installedAt: capture.installedAt,
    observedAt: Date.now(),
    connections: capture.connections.map((connection) => ({ ...connection, messages: connection.messages.slice(-500) }))
  });
  function PuffyWebSocket(url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    const connection = {
      id: 'ws-' + capture.installedAt + '-' + (++capture.sequence),
      url: redact(url).slice(0, 2000),
      protocols: Array.isArray(protocols) ? protocols.map(redact).slice(0, 20) : protocols ? [redact(protocols)] : [],
      protocol: '', extensions: '', state: 'connecting', startedAt: Date.now(), openedAt: 0, closedAt: 0,
      closeCode: 0, closeReason: '', sentBytes: 0, receivedBytes: 0, messages: []
    };
    capture.connections.push(connection);
    if (capture.connections.length > 100) capture.connections.shift();
    const record = (direction, data) => {
      const detail = describe(data);
      const message = { id: connection.id + '-message-' + (++capture.sequence), direction, at: Date.now(), ...detail };
      connection.messages.push(message);
      if (connection.messages.length > 500) connection.messages.shift();
      if (direction === 'outgoing') connection.sentBytes += detail.bytes;
      else connection.receivedBytes += detail.bytes;
    };
    const nativeSend = socket.send;
    socket.send = function(data) { record('outgoing', data); return nativeSend.call(this, data); };
    socket.addEventListener('open', () => { connection.state = 'open'; connection.openedAt = Date.now(); connection.protocol = redact(socket.protocol); connection.extensions = redact(socket.extensions); });
    socket.addEventListener('message', (event) => record('incoming', event.data));
    socket.addEventListener('close', (event) => { connection.state = 'closed'; connection.closedAt = Date.now(); connection.closeCode = Number(event.code || 0); connection.closeReason = redact(event.reason); });
    socket.addEventListener('error', () => { connection.state = 'error'; });
    return socket;
  }
  Object.setPrototypeOf(PuffyWebSocket, NativeWebSocket);
  PuffyWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) try { Object.defineProperty(PuffyWebSocket, key, { value: NativeWebSocket[key] }); } catch {}
  window.WebSocket = PuffyWebSocket;
  window.__puffyWebSocketCapture = capture;
  window.__puffyWebSocketSnapshot = snapshot;
  return true;
})()`;

export const WEBSOCKET_SNAPSHOT_EXPRESSION = `(() => typeof window.__puffyWebSocketSnapshot === 'function' ? window.__puffyWebSocketSnapshot() : null)()`;

export function validateWebSocketSnapshot(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.connections)) return { version: 1, installedAt: 0, observedAt: Date.now(), connections: [] };
  return {
    version: 1,
    installedAt: finite(value.installedAt),
    observedAt: finite(value.observedAt),
    connections: value.connections.slice(-100).map((connection, index) => ({
      id: text(connection.id, 160) || `ws-${index}`,
      url: text(connection.url, 2000),
      protocols: Array.isArray(connection.protocols) ? connection.protocols.slice(0, 20).map((item) => text(item, 200)) : [],
      protocol: text(connection.protocol, 200),
      extensions: text(connection.extensions, 500),
      state: ["connecting", "open", "closed", "error"].includes(connection.state) ? connection.state : "unknown",
      startedAt: finite(connection.startedAt), openedAt: finite(connection.openedAt), closedAt: finite(connection.closedAt),
      closeCode: finite(connection.closeCode), closeReason: text(connection.closeReason, 500),
      sentBytes: finite(connection.sentBytes), receivedBytes: finite(connection.receivedBytes),
      messages: Array.isArray(connection.messages) ? connection.messages.slice(-500).map((message, messageIndex) => ({
        id: text(message.id, 180) || `ws-${index}-message-${messageIndex}`,
        direction: message.direction === "outgoing" ? "outgoing" : "incoming",
        at: finite(message.at), type: text(message.type, 40), bytes: finite(message.bytes), preview: text(message.preview, 12000)
      })) : []
    }))
  };
}

export function summarizeWebSockets(snapshot) {
  const connections = snapshot?.connections || [];
  const messages = connections.flatMap((connection) => connection.messages || []);
  return {
    connections: connections.length,
    open: connections.filter((connection) => connection.state === "open").length,
    messages: messages.length,
    sentBytes: connections.reduce((sum, connection) => sum + connection.sentBytes, 0),
    receivedBytes: connections.reduce((sum, connection) => sum + connection.receivedBytes, 0)
  };
}

function text(value, limit) { return String(value ?? "").slice(0, limit); }
function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
