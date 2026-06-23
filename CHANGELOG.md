# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0]

### Added

- **User overrides files (update-safe config).** `~/.config/opencode/opencode-model-router.overrides.jsonc`
  (global) and `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) are deep-merged over the
  bundled `tiers.json` — specify only the keys you want to change. `.jsonc`, so `//`/`/* */` comments and
  trailing commas are allowed. The project file is found by
  searching upward to the repo root and wins over the global file, which wins over the defaults.
  Customize models/tiers/presets without editing the cached package file (fixes the "edits to the
  cached `tiers.json` get wiped on update / are ignored" pain). An overrides file can also define an
  entirely new preset — `model` is the only required field per tier; `costRatio`/`steps` default to the
  conventional `1`/`5`/`20` and `30`/`50`/`120` by tier name when omitted, and `description`/`whenToUse`
  are optional.
- **`/router overrides`** — shows the global + project override paths, which exist, and the merge
  precedence.
- **`/router models [provider]`** — lists valid model ids from your configured providers (with the
  per-provider default and `deprecated`/`alpha`/`beta` flags), read from opencode's live catalog.
- **Stale/deprecated model validation** — the active preset's tier models are checked against the
  catalog; misses surface in bare `/router` (with closest-match suggestions) and a one-time
  plugin-log warning, so a bad model id no longer fails silently on every subagent dispatch.

### Fixed

- **GitHub Copilot preset model IDs.** Corrected to valid ids (`claude-sonnet-4.6`,
  `claude-opus-4.8` with the `high` variant; `claude-haiku-4.5` for the fast tier) so subagent dispatch
  no longer errors with `ProviderModelNotFoundError`.
- **Local-plugin install docs.** opencode ignores a `{ "type": "local" }` entry in `opencode.json`
  (it npm-installs the package by name instead); documented the working mechanism — a re-export
  shim in `~/.config/opencode/plugins/`.

### Internal

- Modularized the plugin: extracted pure command renderers (`src/commands/output.ts`), the model
  catalog (`src/router/catalog.ts`), and the Layer-2 verification wiring (`src/verify/wiring.ts`);
  split the 362-line `validateConfig` into per-section validators; trimmed per-tool-call hot paths
  and gated record-only trajectory work. Reference docs updated; test coverage raised to ~93%.

## [1.3.0]

### Changed — advisory enforcement is now the default

- **Default enforcement mode flipped `off` → `advisory`.** With `enforcement.mode`
  unset, every non-trivial delegation is now verified and any miss surfaces a
  non-blocking forcing-note; the orchestrator system prompt grows by ~200 tokens for
  the DoD/acceptance section, and subagents may receive non-blocking guard banners.
  Nothing is ever hard-blocked in `advisory`. To restore the previous byte-identical
  behaviour (zero added tokens, zero new latency), set `"mode": "off"` explicitly, run
  `/router enforce off`, or set `MODEL_ROUTER_ENFORCE=0`.
- **The custom `delegate` tool is now hidden by default.** Delegation routes through the
  native `Task()` tool so subagents render inline in the TUI instead of running in an
  invisible orphan session (fixes the `delegate [tier=…, task=…]` stall). The
  independently-verified `delegate` tool remains available behind an opt-in flag.
- The acceptance forcing-note now includes tier-escalation guidance
  (`Task(subagent_type="<nextTier>")`) when a delegated result is not accepted.

### Added

- `experimental.verifiedDelegateTool` config flag in `tiers.json`, and the
  `MODEL_ROUTER_VERIFIED_DELEGATE=1` environment variable, to opt back into the
  authoritative `delegate` tool.

## [1.2.0]

### Added — Enforced delegation (opt-in, default OFF)

A three-layer enforcement system that makes tiered delegation *reliable* instead of
advisory. **It is opt-in and disabled by default**: with `enforcement.mode` unset (or
`"off"`), behaviour is byte-identical to previous releases — no added prompt tokens, no
new runtime behaviour. Enable per repo via `enforcement.mode` in `tiers.json`, per run
via the `MODEL_ROUTER_ENFORCE=1` environment variable, or per session via
`/router enforce <off|advisory|enforced>`. Enforcement applies only to subagent/delegate
sessions; the orchestrator session is never gated.

- **Layer 1 — hard-block guard** (`tool.execute.before`): an in-band, throw-to-block
  guard for subagent sessions. Enforces a tool-call budget ceiling, anti-redundancy
  (repeated identical reads), and anti-self-script (ad-hoc `bash` execution such as
  heredocs / `node -e` / `cat >`), with an optional deliverable-first rule. Writing
  source files is *never* blocked by default (`blockScriptWrites` is opt-in).
  `off` is a no-op, `advisory` surfaces a banner, `enforced` blocks.
- **Layer 2 — independent acceptance gate**: turns "the producer says it's done" into
  "the output was objectively accepted". A Definition-of-Done is parsed from an
  `[acceptance]` block (Mode B) or auto-inferred from the dispatch (Mode A) and checked
  either deterministically (`run` / `fileExists` / `schemaMatch` / `testsPass` /
  `buildPasses` / `lintClean` behind an allowlisted exec/fs seam) or by an **independent
  grader** in a fresh session at a tier ≥ the producer's. Fail-closed: any error,
  unparseable verdict, or non-independent grader counts as a failure. Never silently
  accepts a non-trivial delegation that lacks a checkable DoD.
- **Layer 3 — quality-escalation ladder**: on a failed gate the authoritative `delegate`
  tool retries, then escalates `fast → medium → heavy`, then returns an honest
  `status: unmet` — never a fake pass. Provably terminating (bounded by
  `maxAttemptsPerTier`, `maxTotalAttempts`, and a cost ceiling) and composes with the
  existing advisory provider-failover chain without double-counting attempts.

### Added — tooling & APIs

- New `delegate` tool (authoritative produce → verify → escalate in one call) alongside
  the existing raw `Task()` path (advisory-grade verify-dispatch).
- New `/router enforce <off|advisory|enforced>` command (persisted atomically).
- New `enforcement` configuration block in `tiers.json` (fully validated; see
  `docs/CONFIG_REFERENCE.md`). Per-mode example presets in `docs/ENFORCEMENT_PRESETS.md`.
- TypeScript + Vitest test infrastructure, golden-snapshot characterization tests, and a
  coverage gate. Documentation suite: `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`,
  `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`, `docs/MIGRATION.md`, and ADRs
  `docs/adr/0000`–`0002`.

### Security

- Secret scrubbing (`scrubText`) is applied to every model-visible string the enforcement
  layers emit — forcing messages, grader prompts, scorecards, and trajectory dumps.
- The deterministic verifier runs only allowlisted binaries, rejects shell
  metacharacters, and blocks interpreter eval flags (`node -e`, `python -c`, …).

### Notes

- Default is OFF; upgrading changes nothing until you opt in. See `docs/MIGRATION.md`.
- The bundled per-mode enforcement presets are **preliminary** (tuned from fixtures, not
  field telemetry) and are documented rather than written into `tiers.json`.
