import { makeId } from "./utils.js";

const LOGOUT_PATTERN = /(?:^|[\/_-])(logout|signout|logoff)(?:$|[\/?#_-])/i;

export class SiteCrawler {
  constructor(adapter, { maxRoutes = 100, defaultRoutes = 25 } = {}) {
    this.adapter = adapter;
    this.maxRoutes = maxRoutes;
    this.defaultRoutes = defaultRoutes;
    this.cancelled = false;
  }

  async discover(currentUrl, fallbackLinks = []) {
    const requested = await this.adapter.discoverRoutes?.(currentUrl);
    const candidates = requested?.length ? requested : fallbackLinks;
    return sanitizeRoutes(candidates, currentUrl, this.maxRoutes);
  }

  async run(urls, { originalUrl, limit = this.defaultRoutes, onRoute, onProgress, onRouteComplete } = {}) {
    const queue = sanitizeRoutes(urls, originalUrl, Math.min(this.maxRoutes, Math.max(1, limit)));
    const run = { id: makeId("site-audit"), startedAt: new Date().toISOString(), endedAt: null, status: "running", source: "sitemap-or-links", originalUrl, routes: [] };
    this.cancelled = false;
    try {
      for (let index = 0; index < queue.length && !this.cancelled; index += 1) {
        const url = queue[index];
        onProgress?.({ index, total: queue.length, url, run });
        await this.adapter.navigateTo?.(url);
        await this.adapter.waitForNetworkQuiet?.();
        const result = await onRoute?.(url, index);
        if (result) {
          run.routes.push(compactRouteResult(result));
          onRouteComplete?.({ index, total: queue.length, url, route: run.routes.at(-1), run });
        }
      }
      run.status = this.cancelled ? "cancelled" : "complete";
    } catch (error) {
      run.status = "failed";
      run.error = String(error?.message || error).slice(0, 300);
    } finally {
      run.endedAt = new Date().toISOString();
      if (originalUrl) await this.adapter.navigateTo?.(originalUrl);
    }
    return run;
  }

  cancel() { this.cancelled = true; }
}

export function sanitizeRoutes(urls, originalUrl, limit = 100) {
  let origin;
  try { origin = new URL(originalUrl).origin; } catch { return []; }
  const seen = new Set();
  const result = [];
  for (const raw of urls || []) {
    let url;
    try { url = new URL(raw, originalUrl); } catch { continue; }
    url.hash = "";
    if (!/^https?:$/.test(url.protocol) || url.origin !== origin || LOGOUT_PATTERN.test(url.pathname)) continue;
    if (/\.(?:zip|pdf|png|jpe?g|gif|webp|svg|mp4|mp3|woff2?|ttf)(?:$|\?)/i.test(url.href)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    result.push(url.href);
    if (result.length >= limit) break;
  }
  return result;
}

function compactRouteResult(result) {
  const findings = [...(result.findings || []), ...(result.securityFindings || [])].sort((a, b) => rank(b.severity) - rank(a.severity)).slice(0, 20);
  return {
    url: result.url,
    title: result.title || "",
    score: result.score,
    categoryScores: result.categoryScores || [],
    findings,
    capturedAt: new Date().toISOString(),
    metrics: result.metrics || {}
  };
}

function rank(severity) { return ({ critical: 5, high: 4, serious: 4, medium: 3, moderate: 3, low: 2, minor: 1 })[severity] || 0; }
