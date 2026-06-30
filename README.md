# Puffy Deep Debugger

Puffy is a low-permission Chrome DevTools extension for journey-oriented website auditing. Version 0.5 combines performance, API, accessibility, SEO, reliability, privacy, security, and interactive diagnostics without using `chrome.debugger`, host permissions, or an external analysis service.

## Capabilities

- Backfills the current DevTools HAR, then deduplicates it against live network events.
- Records an automatic **Initial page load** step and manual steps such as Search, Login, or Add to cart.
- Attributes requests, services, interactions, long tasks, failures, and transfer size to journey steps.
- Captures TTFB, FCP, LCP, CLS, INP-style interaction latency, navigation milestones, memory, resource initiators, priority, protocol, cache, and Server-Timing data where Chrome exposes it.
- Normalizes REST endpoints and recognizes GraphQL operation metadata without retaining raw request bodies.
- Detects retries, duplicate calls, possible N+1 traffic, serial API chains, redirects, CORS preflights, payload growth, and unstable services.
- Builds request dependency edges from HAR initiators, with clearly labeled timing-based inference when exact initiators are unavailable.
- Fetches redacted request and response previews only when a request drawer is opened.
- Copies reproducible redacted cURL commands and request/response JSON from the shared request inspector.
- Formats JSON as searchable expandable trees or syntax-colored raw text, with a dedicated GraphQL operation, variables, data, and errors view.
- Observes future WebSocket connections and redacted text frames while the panel is open, including GraphQL-over-WebSocket frame inspection.
- Paginates network calls at 100 rows per page for large sessions.
- Provides whole-row request inspection and filters for steps, methods, status, resource type, domain, party, security risk, caching, compression, bodies, API style, protocol, initiator, confidence, duration, transfer, and capture time.
- Runs an explicit full audit with editable category weights, budgets, weighted coverage, deterministic local narrative, bundled axe-core WCAG checks, and attributed Web Vitals.
- Adds API-first security analysis for transport, URLs, CORS, cookies, caching, disclosure headers, page security headers, GraphQL, external assets, and explicit redacted response-shape checks.
- Discovers same-origin routes from sitemaps or page links and audits up to 100 routes sequentially while restoring the original inspected URL.
- Renders a draggable sitemap constellation with Map/List synchronization, route search, score clustering, metric sizing, keyboard navigation, and evidence details.
- Adds dependency-chain evidence, journey diagnostic playback, network time brushing, attributed vital details, and benchmark sparklines using a locally bundled D3 runtime.
- Pauses graph simulations outside active views and provides deterministic static layouts when reduced motion is requested.
- Routes every API reference to one request inspector, including grouped endpoint evidence with previous and next navigation.
- Uses a compact Modern Observability interface with vendored Lucide icons, semantic status colors, dense network tables, responsive DevTools layouts, and persistent light/dark themes.
- Saves only explicitly named captures to `chrome.storage.local`, including rename, note, delete, storage usage, and two-capture comparison.
- Exports a standalone HTML report containing static sitemap topology, journey lanes, dependency highlights, findings, services, requests, assets, and an optional saved-capture comparison.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `/Users/amand111/Documents/puffy`.
5. Open a website and Chrome DevTools.
6. Select the **Puffy** panel and reload the inspected page.

After editing an already loaded unpacked extension, click **Reload** on its `chrome://extensions` card before reopening DevTools.

## Journey Workflow

1. Reload with Puffy open to capture **Initial page load**.
2. Enter a step name and select **Start step**.
3. Perform the interaction in the inspected page.
4. Select **Stop step**.
5. Run a full audit and review Journeys, Network, Services, Dependencies, Audit, Security, and Findings.
6. Name and save meaningful captures from the Saved view when comparison is needed.

## Development

```bash
npm test
npm run check
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/src/panel.html` for deterministic demo data. Add `?fixture=large` to render the 1,000-request pagination fixture.

## Privacy And Limits

- `storage` is the only extension permission. Puffy does not use `chrome.debugger` because debugger attachments conflict with an open DevTools frontend.
- Authorization, cookie, API-key, and similar header values are redacted. Common secret fields in body previews are redacted on a best-effort basis.
- Request and response previews remain in memory for the current panel session and are never written to saved captures.
- WebSocket connection and frame previews are ephemeral, capped, and never written to saved captures. Only sockets created after page instrumentation are visible; reconnecting a socket can improve coverage.
- Security findings are diagnostic. Inferred and manual-review concerns are labeled and are not presented as proven vulnerabilities.
- Site audits visit only same-origin HTTP(S) documents, skip logout and binary-looking routes, never submit forms, and retain only route aggregates plus the top findings.
- Chrome may omit bodies, initiator stacks, resource timings, or cross-origin details. Puffy labels dependency edges as exact or inferred instead of presenting heuristics as facts.
- Existing WebSocket connections cannot be backfilled, and binary frames are represented by size and type only. SSE message contents, CPU flame charts, and JavaScript/CSS coverage remain outside the DevTools-only architecture.
