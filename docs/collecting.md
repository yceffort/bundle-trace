# Collecting coverage

The Rust analyzer reads saved recordings. You can use your own tooling to create a [supported input](usage.md#coverage-inputs), or use the optional Playwright/Chromium collector, `coldpath collect`.

## Setup

```sh
npm install --save-dev playwright
npx playwright install chromium
```

Use Node.js 24+. On Linux CI, `npx playwright install --with-deps chromium` also installs Chromium's system dependencies. Playwright is an optional peer dependency of `coldpath`; only collection needs it.

Build with source maps, serve that build, and keep the exact generated files available on disk. For example, if `/assets/app.js` is served from `dist/assets/app.js`:

```sh
coldpath collect \
  --url http://127.0.0.1:3000/ \
  --dir dist/assets \
  --prefix /assets/ \
  --scenario initial \
  --out artifacts/initial.coverage.json

bundle-trace --dir dist/assets \
  --coverage artifacts/initial.coverage.json \
  --html artifacts/report.html
```

The default prefix is `/`. It is a URL path prefix, unlike the analyzer's `--url-prefix`, which is a full URL. Use `--prefix /_next/static/` and the corresponding build's `static` directory for a Next.js application.

## Custom interactions

An action module default-exports an async function receiving `{page, context}`. It runs after the initial navigation and observation window. Use Playwright to wait for the application to finish the interaction before returning:

```js
// scenarios/search.mjs
export default async function ({ page }) {
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox").fill("javascript");
  await page.getByTestId("search-result").first().waitFor({ state: "visible" });
}
```

```sh
coldpath collect \
  --url http://127.0.0.1:3000/ \
  --dir dist/assets --prefix /assets/ \
  --scenario search --actions scenarios/search.mjs \
  --out artifacts/search.coverage.json

bundle-trace --dir dist/assets \
  --coverage artifacts/initial.coverage.json \
  --coverage artifacts/search.coverage.json \
  --html artifacts/combined.html
```

The module runs as local Node.js code. Paths are resolved from the current working directory. Each collector invocation launches a fresh browser, so an interaction recording also contains its initial page load. Keep interactions in the existing page; cross-document navigation can discard script sources before they are saved. Record separate full-page navigations in separate invocations.

## Scenario files

A scenario file records several scenarios in order and gives the analyzer the matching order:

```json
{
  "url": "http://127.0.0.1:3000/",
  "dir": "dist/assets",
  "prefix": "/assets/",
  "out": "artifacts/coverage",
  "scenarios": [
    {"name": "initial"},
    {"name": "search", "actions": "scenarios/search.mjs"},
    {"name": "settings", "url": "/settings"}
  ]
}
```

```sh
coldpath collect --scenarios coldpath.scenarios.json
coldpath analyze --scenarios coldpath.scenarios.json --html artifacts/combined.html
```

`collect` writes `<out>/<name>.coverage.json` for each scenario (default `out`: `coldpath-coverage`). `analyze` adds `--dir`, one `--coverage` per scenario, `--scenario-order` in file order, and `--initial-scenario` set to the first scenario unless you pass it, then forwards your other options. Paths are relative to the scenario file. A scenario `url` resolves against the top-level `url`; `prefix`, `waitMs`, and the [environment options](#device-throttling-and-authenticated-state) can be set at the top level or per scenario. Names may contain letters, digits, `_`, `.`, and `-`.

## Device, throttling, and authenticated state

By default the collector uses a 1280x900 desktop viewport with no throttling and an empty browser profile.

| CLI option | Scenario file key | Effect |
| --- | --- | --- |
| `--device NAME` | `device` | A [Playwright device descriptor](https://playwright.dev/docs/emulation#devices) such as `"Pixel 7"`: viewport, user agent, touch, mobile mode, and device scale factor. Recording always uses Chromium, whatever the descriptor's default browser. |
| `--viewport WxH` | `viewport: {width, height}` | Overrides the device viewport. |
| `--user-agent UA` | `userAgent` | Overrides the user agent. |
| `--device-scale-factor N` | `deviceScaleFactor` | Overrides the pixel ratio. |
| `--mobile`, `--touch` | `isMobile`, `hasTouch` | Mobile meta-viewport handling and touch events. |
| `--latency-ms N --download-kbps N --upload-kbps N` | `network: {latencyMs, downloadKbps, uploadKbps}` | Chromium network emulation. All three values are required. |
| `--cpu-slowdown N` | `cpuSlowdown` | Chromium CPU throttling rate (`1` is no slowdown). |
| `--storage-state FILE` | `storageState` | A Playwright [storage state](https://playwright.dev/docs/auth) file with cookies and local storage, for example from a logged-in session. |

Explicit options override the device's values. The envelope's `environment` records the device name, viewport, effective user agent, scale factor, mobile and touch flags, network and CPU settings, and whether a storage state was loaded. It never records the storage state's contents or path. Keep storage state files out of version control; they usually contain session cookies.

Throttling changes which code runs only when the application reacts to timing (for example, timeouts or network-dependent fallbacks). Coverage from throttled recordings is still not a performance measurement.

## What is recorded

The collector starts precise V8 coverage before navigation, waits for `networkidle`, waits another 1,000 ms by default, runs optional actions, and takes one coverage snapshot. `--wait-ms 0` removes the extra observation window. Pages with persistent requests may never reach `networkidle`; use your own Playwright recording when a different readiness condition is required.

Only the page's CDP target is captured. Workers, other tabs, and server-side execution are outside its scope. Service workers and cross-origin requests are blocked. Applications requiring external APIs or CDN scripts need a different collector. Page runtime errors and unsuccessful navigation cause capture to fail. Precise coverage changes execution behavior, so capture durations are not performance measurements.

Matching `.js`, `.mjs`, and `.cjs` scripts are checked against the local build with SHA-256. The artifact records those hashes, local map hashes (or explicit map absence), V8 function ranges, and capture metadata. Inline and eval scripts without a matching file extension are excluded. A missing matching file, stale build, or path outside `--dir` is an error.

The collector supports adjacent `.js.map` files and relative local maps referenced by a final standalone `//# sourceMappingURL=...` or `//@ sourceMappingURL=...` comment. Its map support is narrower than the Rust analyzer: inline `data:` maps, block-comment references, explicit map overrides, and remote maps are not supported by this helper. Use external source-map files for these captures.

Preserve the JavaScript, maps, and recordings together. A recording from an earlier build cannot be safely applied to a changed bundle, even when its path or length is identical. The map hash binds the local map used during capture; it does not prove that the build system generated a correct map.
