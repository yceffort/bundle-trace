# Collecting coverage

The Rust analyzer reads saved recordings. You can use your own tooling to create a [supported input](usage.md#coverage-inputs), or use this repository's optional Playwright/Chromium collector.

## Setup

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Use Node.js 24+ and pnpm 12.1.0. On Linux CI, `pnpm exec playwright install --with-deps chromium` also installs Chromium's system dependencies.

Build with source maps, serve that build, and keep the exact generated files available on disk. For example, if `/assets/app.js` is served from `dist/assets/app.js`:

```sh
node scripts/collect.mjs \
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
node scripts/collect.mjs \
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

## What is recorded

The collector starts precise V8 coverage before navigation, waits for `networkidle`, waits another 1,000 ms by default, runs optional actions, and takes one coverage snapshot. `--wait-ms 0` removes the extra observation window. Pages with persistent requests may never reach `networkidle`; use your own Playwright recording when a different readiness condition is required.

Only the page's CDP target is captured. Workers, other tabs, and server-side execution are outside its scope. Service workers and cross-origin requests are blocked. Applications requiring external APIs or CDN scripts need a different collector. Page runtime errors and unsuccessful navigation cause capture to fail. Precise coverage changes execution behavior, so capture durations are not performance measurements.

Matching `.js`, `.mjs`, and `.cjs` scripts are checked against the local build with SHA-256. The artifact records those hashes, local map hashes (or explicit map absence), V8 function ranges, and capture metadata. Inline and eval scripts without a matching file extension are excluded. A missing matching file, stale build, or path outside `--dir` is an error.

The collector supports adjacent `.js.map` files and relative local maps referenced by a final standalone `//# sourceMappingURL=...` or `//@ sourceMappingURL=...` comment. Its map support is narrower than the Rust analyzer: inline `data:` maps, block-comment references, explicit map overrides, and remote maps are not supported by this helper. Use external source-map files for these captures.

Preserve the JavaScript, maps, and recordings together. A recording from an earlier build cannot be safely applied to a changed bundle, even when its path or length is identical. The map hash binds the local map used during capture; it does not prove that the build system generated a correct map.
