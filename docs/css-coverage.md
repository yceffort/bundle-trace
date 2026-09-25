# CSS coverage: feasibility decision

**Decision (2026-09-25): CSS is not analyzed.** Chromium's rule usage data can be collected and bound to local files, but it cannot yet be reported with the same meaning as JavaScript's observed, unobserved, and unmeasured bytes. This records what was measured and what would have to change.

## What works

Measured with Chromium through Playwright 1.63 and the `CSS` CDP domain (`CSS.startRuleUsageTracking`, `CSS.takeCoverageDelta`):

- **Hash binding.** `CSS.getStyleSheetText` returned exactly the served file: its SHA-256 matched the local build file, so a capture can be bound to a build like scripts are.
- **Range format.** Each delta lists style rules that matched since the previous delta, as offsets into the stylesheet text. This is the shape of the analyzer's existing DevTools `{url, text, ranges}` input (used intervals, no counts).
- **Scenarios.** Rules first matched after an interaction (a class inserted by a click, a `:hover` rule after hovering) appear only in the later delta, so first-observation scenarios would work as for JavaScript.

## Why it is not adopted

1. **Bytes that are in use are reported as unused.** Rule usage covers style rules only. In the probe, a used `@keyframes` block and a used `@font-face` rule never appeared in any delta, and neither do at-rule wrappers such as `@media (...) {`. Rules matching only elements inside a `display: none` subtree were not reported either. Without classification, these bytes would be shown as unobserved, which for JavaScript means "did not run". Keeping the guarantee requires a CSS parser that marks bytes outside style rules as unmeasured rather than unobserved; the analyzer has none.
2. **Common production builds have no CSS source maps.** esbuild wrote a CSS map with one source per input file. A Vite 8 production build with `build.sourcemap: true` wrote no CSS map and no `sourceMappingURL` comment, so its whole stylesheet would be one `[unmapped]` source. PostCSS, Tailwind, and CSS Modules pipelines were not measured.
3. **Totals and budgets would change meaning.** Adding stylesheet bytes to `totals`, `--max-bytes`, and `--max-unobserved-bytes` would silently change existing reports and CI budgets. CSS needs its own totals, budgets, and report wording (rule matched, not code executed), which is a report schema change.

## What adoption would take

- A CSS tokenizer in the analyzer that separates style rule ranges (measurable) from at-rules and wrappers (unmeasured).
- A collector option that records rule usage deltas per stylesheet with SHA-256 and map hashes, alongside `scripts` in the envelope.
- Separate CSS totals, budgets, and labels in JSON, Markdown, HTML, and the treemap, with a schema version bump.
- A browser check with a real recording, including `@keyframes`, `@font-face`, `@media`, and `:hover` rules.
