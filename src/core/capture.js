import { redactSecrets } from "./utils.js";
import { PAGE_AUDIT_EXPRESSION } from "./audit.js";

const TELEMETRY_EXPRESSION = `(() => {
  const timeOrigin = performance.timeOrigin;
  if (!window.__puffyTelemetry || window.__puffyTelemetry.timeOrigin !== timeOrigin) {
    const telemetry = window.__puffyTelemetry = { timeOrigin, lcp: 0, cls: 0, interactions: new Map(), longTasks: [] };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const latest = entries[entries.length - 1];
        if (latest) telemetry.lcp = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) telemetry.cls += entry.value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.interactionId) continue;
          const current = telemetry.interactions.get(entry.interactionId);
          if (!current || entry.duration > current.duration) telemetry.interactions.set(entry.interactionId, { interactionId: entry.interactionId, name: entry.name, startTime: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) telemetry.longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name || "long task", attribution: (entry.attribution || []).map((item) => item.containerName || item.name || "unknown") });
        telemetry.longTasks = telemetry.longTasks.slice(-300);
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  }
  const telemetry = window.__puffyTelemetry;
  const nav = performance.getEntriesByType("navigation")[0];
  const paints = performance.getEntriesByType("paint");
  const fcp = paints.find((paint) => paint.name === "first-contentful-paint")?.startTime || 0;
  const interactions = [...telemetry.interactions.values()];
  const durations = interactions.map((item) => item.duration).sort((a, b) => b - a);
  const inpIndex = Math.min(durations.length - 1, Math.floor(durations.length / 50));
  const resources = performance.getEntriesByType("resource").slice(-1000).map((entry) => ({
    id: "resource-" + timeOrigin + "-" + entry.startTime + "-" + entry.name,
    name: entry.name,
    initiatorType: entry.initiatorType || "other",
    renderBlockingStatus: entry.renderBlockingStatus || "",
    nextHopProtocol: entry.nextHopProtocol || "",
    deliveryType: entry.deliveryType || "",
    startTime: entry.startTime,
    absoluteStart: timeOrigin + entry.startTime,
    fetchStart: entry.fetchStart,
    responseStart: entry.responseStart,
    responseEnd: entry.responseEnd,
    transferSize: entry.transferSize || 0
  }));
  return {
    observedAt: Date.now(), timeOrigin, url: location.href, title: document.title,
    navigation: {
      ttfb: nav?.responseStart || 0,
      domInteractive: nav?.domInteractive || 0,
      domComplete: nav?.domComplete || 0,
      loadEventEnd: nav?.loadEventEnd || 0,
      usedJSHeapSize: performance.memory?.usedJSHeapSize || 0,
      resourceCount: resources.length
    },
    fcp, lcp: telemetry.lcp || 0, cls: telemetry.cls || 0,
    inp: inpIndex >= 0 ? durations[inpIndex] : 0,
    interactions: interactions.map((item) => ({ ...item, kind: "interaction", id: "interaction-" + timeOrigin + "-" + item.interactionId, absoluteStart: timeOrigin + item.startTime })),
    longTasks: telemetry.longTasks.map((item) => ({ ...item, kind: "longtask", id: "longtask-" + timeOrigin + "-" + item.startTime, absoluteStart: timeOrigin + item.startTime })),
    resources
  };
})()`;

const SNAPSHOT_EXPRESSION = `(() => {
  const scripts = [...document.scripts].map((script) => script.src || "");
  const hints = [];
  if (document.querySelector("#__next") || scripts.some((src) => src.includes("/_next/"))) hints.push("Next.js");
  if (document.querySelector("[data-reactroot], #root") || scripts.some((src) => /react/i.test(src))) hints.push("React");
  if (document.querySelector("[data-v-app]") || scripts.some((src) => /vue/i.test(src))) hints.push("Vue");
  if (document.querySelector("[ng-version]") || scripts.some((src) => /angular/i.test(src))) hints.push("Angular");
  return {
    url: location.href, title: document.title, scripts,
    stylesheets: [...document.querySelectorAll('link[rel~="stylesheet"], style')].map((node) => node.href || ""),
    images: [...document.images].map((img) => img.currentSrc || img.src || ""),
    imagesMissingAlt: [...document.images].filter((img) => !img.hasAttribute("alt")).length,
    forms: [...document.forms].map((form) => ({ action: form.action || location.href, method: (form.method || "get").toUpperCase(), inputs: form.querySelectorAll("input, select, textarea, button").length })),
    domNodes: document.getElementsByTagName("*").length,
    linkCount: document.links.length,
    inlineScriptChars: [...document.scripts].reduce((sum, script) => sum + (!script.src ? script.textContent.length : 0), 0),
    inlineStyleChars: [...document.querySelectorAll("style")].reduce((sum, style) => sum + style.textContent.length, 0),
    frameworkHints: [...new Set(hints)],
    visibleText: document.body?.innerText?.replace(/\\s+/g, " ").trim().slice(0, 5000) || ""
  };
})()`;

export class DevToolsCaptureAdapter {
  constructor(chromeApi, callbacks = {}) {
    this.chrome = chromeApi;
    this.callbacks = callbacks;
    this.handles = new Map();
    this.requestIdsByKey = new Map();
    this.telemetryTimer = null;
    this.navigationWaiters = [];
    this.runtimeReady = false;
    this.onRequestFinished = (entry) => this.emitEntry(entry, "live");
    this.onNavigated = (url) => {
      this.callbacks.onNavigated?.(url);
      this.navigationWaiters.splice(0).forEach((resolve) => resolve(url));
      setTimeout(() => this.sampleTelemetry(), 1200);
      setTimeout(() => this.captureSnapshot(), 1400);
    };
  }

  async start() {
    this.chrome.devtools.network.onRequestFinished.addListener(this.onRequestFinished);
    this.chrome.devtools.network.onNavigated.addListener(this.onNavigated);
    this.chrome.devtools.network.getHAR((har) => {
      for (const entry of har?.entries || []) this.emitEntry(entry, "har");
    });
    this.sampleTelemetry();
    this.captureSnapshot();
    this.telemetryTimer = setInterval(() => this.sampleTelemetry(), 3000);
  }

  stop() {
    this.chrome.devtools.network.onRequestFinished.removeListener?.(this.onRequestFinished);
    this.chrome.devtools.network.onNavigated.removeListener?.(this.onNavigated);
    clearInterval(this.telemetryTimer);
  }

  emitEntry(entry, source) {
    this.callbacks.onRequest?.(entry, source, (id) => {
      const existing = this.handles.get(id);
      if (!existing || typeof entry.getContent === "function") this.handles.set(id, entry);
      this.requestIdsByKey.set(`${entry.request?.method}|${entry.request?.url}|${entry.startedDateTime}`, id);
    });
  }

  sampleTelemetry() {
    this.chrome.devtools.inspectedWindow.eval(TELEMETRY_EXPRESSION, (result, exception) => {
      if (!exception && result) this.callbacks.onTelemetry?.(result);
    });
  }

  captureSnapshot() {
    this.chrome.devtools.inspectedWindow.eval(SNAPSHOT_EXPRESSION, (result, exception) => {
      if (!exception && result) this.callbacks.onSnapshot?.(result);
    });
  }

  reload() {
    this.chrome.devtools.inspectedWindow.reload({ ignoreCache: true });
  }

  evaluate(expression) {
    return new Promise((resolve, reject) => this.chrome.devtools.inspectedWindow.eval(expression, (result, exception) => exception ? reject(new Error(exception.value || exception.description || "Inspected page evaluation failed.")) : resolve(result)));
  }

  async ensureAuditRuntime() {
    if (this.runtimeReady) return;
    try {
      const [axeSource, vitalsSource] = await Promise.all([
        fetch(this.chrome.runtime.getURL("src/vendor/axe.min.js")).then((response) => response.text()),
        fetch(this.chrome.runtime.getURL("src/vendor/web-vitals.attribution.iife.js")).then((response) => response.text())
      ]);
      const install = `(() => { try { ${axeSource}\nwindow.__puffyAxeReady=true; axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>{window.__puffyAxeResult={violations:r.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,description:v.description,helpUrl:v.helpUrl,nodes:v.nodes.slice(0,20).map(n=>({target:n.target,html:n.html.slice(0,300)}))})),incomplete:r.incomplete.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.length}))};}).catch(()=>{}); } catch {} try { ${vitalsSource}\nwindow.__puffyVitals=window.__puffyVitals||{}; if(typeof webVitals!=='undefined'){ for(const [name,fn] of [['LCP',webVitals.onLCP],['CLS',webVitals.onCLS],['INP',webVitals.onINP]]) fn?.((metric)=>{window.__puffyVitals[name]={value:metric.value,rating:metric.rating,attribution:metric.attribution||{}};},{reportAllChanges:true}); } } catch {} return true; })()`;
      await this.evaluate(install);
      this.runtimeReady = true;
    } catch { this.runtimeReady = false; }
  }

  async runPageAudit() {
    await this.ensureAuditRuntime();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return this.evaluate(PAGE_AUDIT_EXPRESSION);
  }

  async discoverRoutes(currentUrl) {
    const expression = `(() => { window.__puffyRouteDiscovery=null; (async()=>{ const out=[]; const visited=new Set(); const visit=async(url,depth)=>{ if(depth>3||visited.has(url))return; visited.add(url); try{ const text=await fetch(url,{credentials:'same-origin'}).then(r=>r.ok?r.text():''); const xml=new DOMParser().parseFromString(text,'application/xml'); const locs=[...xml.querySelectorAll('loc')].map(n=>n.textContent.trim()).filter(Boolean); if(xml.documentElement?.localName==='sitemapindex'){ for(const child of locs.slice(0,100)) await visit(child,depth+1); } else out.push(...locs); }catch{} }; try { const robots=await fetch('/robots.txt',{credentials:'same-origin'}).then(r=>r.ok?r.text():''); const maps=[...robots.matchAll(/^sitemap:\\s*(.+)$/gim)].map(m=>m[1].trim()); if(!maps.length) maps.push(new URL('/sitemap.xml',location.href).href); for(const map of maps.slice(0,5)) await visit(map,0); } catch {} if(!out.length) out.push(...[...document.querySelectorAll('a[href]')].map(a=>a.href)); window.__puffyRouteDiscovery=[...new Set(out)].slice(0,500); })(); return true; })()`;
    await this.evaluate(expression);
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const result = await this.evaluate("window.__puffyRouteDiscovery");
      if (Array.isArray(result)) return result;
    }
    return [];
  }

  async navigateTo(url) {
    this.runtimeReady = false;
    const navigation = new Promise((resolve) => this.navigationWaiters.push(resolve));
    await this.evaluate(`location.assign(${JSON.stringify(url)}); true`);
    await Promise.race([navigation, new Promise((resolve) => setTimeout(resolve, 15000))]);
  }

  async waitForNetworkQuiet() { await new Promise((resolve) => setTimeout(resolve, 2500)); }

  async loadBodies(requestId) {
    const handle = this.handles.get(requestId);
    if (!handle) return { state: "unavailable", request: "Request body is no longer available.", response: "Response body is no longer available." };
    const requestText = redactSecrets(handle.request?.postData?.text || "", 12000);
    const responseText = await new Promise((resolve) => {
      if (typeof handle.getContent !== "function") return resolve("");
      handle.getContent((content) => resolve(redactSecrets(content || "", 12000)));
    });
    return { state: requestText || responseText ? "available" : "unavailable", request: requestText || "No request body.", response: responseText || "No text response preview available." };
  }
}

export class DemoCaptureAdapter {
  constructor(callbacks = {}, options = {}) {
    this.callbacks = callbacks;
    this.options = options;
    this.handles = new Map();
  }

  async start() {
    const now = Date.now() - 5000;
    const entries = demoEntries(now, this.options.large ? 1000 : 11);
    entries.forEach((entry) => this.callbacks.onRequest?.(entry, "demo", (id) => this.handles.set(id, entry)));
    this.callbacks.onTelemetry?.(demoTelemetry(now));
    this.callbacks.onSnapshot?.(demoSnapshot());
  }

  stop() {}
  reload() {}
  async runPageAudit() { return demoAuditSignals(); }
  async discoverRoutes() { return ["https://shop.example.com/products", "https://shop.example.com/cart", "https://shop.example.com/checkout"]; }
  async navigateTo(url) { this.callbacks.onNavigated?.(url); }
  async waitForNetworkQuiet() { await new Promise((resolve) => setTimeout(resolve, 20)); }

  async loadBodies(requestId) {
    const entry = this.handles.get(requestId);
    return {
      state: entry ? "available" : "unavailable",
      request: redactSecrets(entry?.request?.postData?.text || "No request body."),
      response: entry?._demoResponse || "No text response preview available."
    };
  }
}

function demoEntries(now, count = 11) {
  const specs = [
    ["GET", "https://shop.example.com/", 200, "document", 620, 34000, "parser"],
    ["GET", "https://cdn.example.com/app.js", 200, "script", 760, 620000, "parser"],
    ["GET", "https://api.shop.example.com/v2/products/101", 200, "xhr", 540, 54000, "script"],
    ["GET", "https://api.shop.example.com/v2/products/102", 200, "xhr", 570, 52000, "script"],
    ["GET", "https://api.shop.example.com/v2/products/103", 200, "xhr", 610, 56000, "script"],
    ["GET", "https://api.shop.example.com/v2/products/104", 200, "xhr", 640, 51000, "script"],
    ["GET", "https://api.shop.example.com/v2/products/105", 200, "xhr", 690, 57000, "script"],
    ["POST", "https://api.shop.example.com/graphql", 500, "fetch", 920, 1400, "script", JSON.stringify({ operationName: "AddToCart", query: "mutation AddToCart { addToCart { id } }", token: "secret" })],
    ["POST", "https://api.shop.example.com/graphql", 200, "fetch", 740, 1800, "script", JSON.stringify({ operationName: "AddToCart", query: "mutation AddToCart { addToCart { id } }", token: "secret" })],
    ["OPTIONS", "https://api.stripe.com/v1/payment_methods", 204, "preflight", 180, 0, "script"],
    ["POST", "https://api.stripe.com/v1/payment_methods", 200, "xhr", 510, 16000, "script", "card=redacted"]
  ];
  while (specs.length < count) {
    const index = specs.length;
    specs.push(["GET", `https://api.shop.example.com/v2/catalog/${index}`, 200, "xhr", 80 + index % 200, 400 + index % 5000, "script"]);
  }
  return specs.map(([method, url, status, resourceType, time, bytes, initiatorType, postData], index) => ({
    startedDateTime: new Date(now + index * 260).toISOString(),
    time,
    _resourceType: resourceType,
    _priority: resourceType === "document" ? "VeryHigh" : "High",
    _initiator: { type: initiatorType, url: initiatorType === "script" ? "https://cdn.example.com/app.js" : "https://shop.example.com/" },
    request: { method, url, httpVersion: "h2", headers: [{ name: "accept", value: resourceType === "xhr" || resourceType === "fetch" ? "application/json" : "*/*" }], queryString: [], postData: postData ? { text: postData } : undefined },
    response: { status, statusText: status >= 500 ? "Server error" : "OK", httpVersion: "h2", headers: [{ name: "content-type", value: resourceType === "document" ? "text/html" : resourceType === "script" ? "application/javascript" : "application/json" }], content: { mimeType: resourceType === "document" ? "text/html" : resourceType === "script" ? "application/javascript" : "application/json", size: bytes }, _transferSize: bytes, redirectURL: "" },
    timings: { blocked: 4, dns: index % 4 ? 0 : 22, connect: index % 4 ? 0 : 45, ssl: index % 4 ? 0 : 30, send: 3, wait: time * 0.72, receive: time * 0.18 },
    serverIPAddress: "203.0.113.10",
    _demoResponse: resourceType === "xhr" || resourceType === "fetch" ? JSON.stringify({ ok: status < 400, data: { id: index } }) : ""
  }));
}

function demoTelemetry(now) {
  return {
    observedAt: now + 5000,
    timeOrigin: now,
    url: "https://shop.example.com/products",
    title: "Acme Store",
    navigation: { ttfb: 420, domInteractive: 1260, domComplete: 2840, loadEventEnd: 3020, usedJSHeapSize: 26_000_000, resourceCount: 11 },
    fcp: 920,
    lcp: 2720,
    cls: 0.07,
    inp: 360,
    interactions: [{ id: `interaction-${now}-1`, kind: "interaction", interactionId: 1, name: "click", startTime: 3500, absoluteStart: now + 3500, duration: 360 }],
    longTasks: [{ id: `longtask-${now}-1`, kind: "longtask", name: "long task", startTime: 3400, absoluteStart: now + 3400, duration: 180, attribution: ["app.js"] }],
    resources: []
  };
}

function demoSnapshot() {
  return { url: "https://shop.example.com/products", title: "Acme Store", scripts: ["https://cdn.example.com/app.js"], stylesheets: ["https://cdn.example.com/app.css"], images: ["https://cdn.example.com/hero.webp"], imagesMissingAlt: 1, forms: [{ method: "POST", action: "/cart", inputs: 4 }], domNodes: 1420, linkCount: 68, inlineScriptChars: 800, inlineStyleChars: 220, frameworkHints: ["React"], visibleText: "Products, recommendations, cart, and checkout." };
}

function demoAuditSignals() {
  return { url: "https://shop.example.com/products", title: "Acme Store Products", lang: "en", description: "Browse products and add them to your cart.", canonical: "https://shop.example.com/products", robots: "index,follow", viewport: "width=device-width,initial-scale=1", h1Count: 1, headings: [1, 2, 2], linkCount: 68, links: ["https://shop.example.com/products", "https://shop.example.com/cart"], imageCount: 4, imagesMissingAlt: 1, formControlsWithoutLabels: 1, buttonsWithoutNames: 0, externalAssets: [{ url: "https://cdn.example.com/app.js", integrity: false, crossOrigin: true }], hasManifest: false, hasFavicon: true, axe: { violations: [{ id: "image-alt", impact: "critical", help: "Images must have alternate text", description: "Ensures images have alternate text", helpUrl: "https://dequeuniversity.com/rules/axe/image-alt", nodes: [{ target: [".product img"] }] }], incomplete: [] }, vitalsAttribution: {} };
}
