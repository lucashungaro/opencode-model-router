# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] — 2026-08-12

### Added

- **`subagentTiers` — route your own pre-existing subagents (opt-in).** A map of agent
  name → tier name (`{ "ContextScout": "fast" }`) repoints those agents at the active
  preset's models, so they follow `/preset` instead of pinning a model id in their own
  definition. Absent or empty ⇒ nothing is touched.

  This closes a real gap: a custom subagent that declares no `model` inherits the model
  of whichever agent invoked it, so read-only helpers silently run at orchestrator
  prices, and opencode has no wildcard for setting them in bulk — every agent must be
  listed individually.

  Entries are skipped, never fatal, when the tier doesn't exist in the active preset,
  when the key collides with a tier name, or when the agent is already registered as a
  non-subagent. The map deliberately wins over an agent's own `model` — that is what
  lets hardcoded model ids be removed from agent files. `variant` is set or cleared
  explicitly rather than merged, so a tier without one can't leave a foreign provider's
  variant behind.

  Note this cannot do per-invocation routing: no opencode hook can change the model of
  an in-flight request (`chat.params` exposes `model` as read-only input), so the
  assignment happens once, at config load.

## [1.6.0] — 2026-08-08

### Changed — all five presets refreshed to current models

Every bundled preset was one to two generations behind. New defaults:

| preset | @fast | @medium | @heavy |
|---|---|---|---|
| `anthropic` | `claude-haiku-4-5` | `claude-sonnet-5` | `claude-opus-5` (high) |
| `openai` | `gpt-5.6-luna` | `gpt-5.6-terra` | `gpt-5.6-sol` (high) |
| `github-copilot` | `gpt-5.6-luna` | `claude-sonnet-5` | `claude-opus-5` (high) |
| `google` | `gemini-3.5-flash-lite` | `gemini-3.6-flash` | `gemini-3.1-pro-preview` |
| `hybrid` | `openai/gpt-5.6-luna` | `anthropic/claude-sonnet-5` | `anthropic/claude-opus-5` (high) |

- **The `google` preset is now laddered by model class** (Flash-Lite → Flash → Pro) rather
  than by version number. Gemini version digits do not track capability across classes —
  `gemini-3.5-flash` is documented as more capable than `gemini-3.6-flash` for agentic and
  coding work — so class is the only ordering that reliably maps onto the tier ladder. It
  also carries no `variant` on any tier, since these models are separated by class rather
  than by reasoning effort. Note that no stable Pro model exists; `@heavy` is a preview
  model, which carries tighter rate limits and a short deprecation notice.
- **`max` is gone as a variant, everywhere.** Variants are now uniform across presets:
  none on `@fast` and `@medium`, `"variant": "high"` on `@heavy` (except `google`). `max` was Anthropic
  direct-API naming that broke when a tier was pointed at the same model through another
  provider — and since `variant` is not validated, it failed at dispatch rather than at
  config load. The uniform convention also means an overrides file that repoints a tier's
  `model` no longer inherits a variant that the new provider doesn't recognize.
- **`hybrid` and `github-copilot` now share one shape** — cheap GPT for exploration, Claude
  Sonnet for implementation, Claude Opus for the hard tier — differing only in whether they
  route through the vendor APIs or through Copilot.
- Tier `description` fields were rewritten to match the new models; `costRatio`, `steps`,
  `whenToUse`, `tierCaps`, `rules`, `modes`, and `taskPatterns` are unchanged.

Overrides files are unaffected: anything you set in
`opencode-model-router.overrides.jsonc` still wins over these defaults.

## [1.5.0] — 2026-08-08

First release of the fork. Published to npm as **`@lucashungaro/opencode-model-router`**;
upstream [`marco-jardim/opencode-model-router`](https://github.com/marco-jardim/opencode-model-router)
has been inactive since 2026-06-06 and its npm package remains at 1.3.0. Same GPL-3.0-only
license, original copyright preserved. See [README](./README.md#fork-notice) for the
divergence notice.

### Changed

- **Package renamed** to `@lucashungaro/opencode-model-router`. Install with
  `"plugin": ["@lucashungaro/opencode-model-router"]`. Remove any `opencode-model-router`
  entry from your `plugin` array first — listing both loads the plugin twice.

### Fixed

- **Read-only research delegations are no longer failed by the grader.** `inferDoD` always
  synthesizes a criterion from the task's first line, so a native `Task()` that only gathered
  information was judged against an imperative criterion and got a false `NOT ACCEPTED`
  forcing note appended. Layer-2 verification is now skipped when the DoD is inferred +
  checker-kind *and* the delegation touched no files. Explicit `[acceptance]` blocks and
  inferred deterministic checks (`build`/`test`/`fileExists`) still verify normally.

### Performance

- **Delegation protocol trimmed ~55%** (core `~1,396 → 632` tokens; typical Claude+advisory
  injection `~1,951 → 1,187`). Routing, caps, and the orchestrator role had each been stated
  2–3 times across hardcoded prose that restated the configurable taxonomy and rules.
  Removed the `HARD ROUTING`, `DISPATCH CAPS`, `ROLE CONTRACT`, `CONFLICT-WITH-CLAUDE.md`,
  and per-tier contract blocks — behavior is unchanged, since routing lives in the
  configurable `R:` taxonomy + numbered rules, cap syntax in rule 7, and per-tier
  behavioral contracts reach subagents through their own `tierPrompts`.
- **Anti-narration is now opt-in** via a new top-level `antiNarration` boolean (default
  `false`), dropping a further ~162 tokens per Claude dispatch (`~1,187 → 1,025` on the
  github-copilot preset). It gated two things: a prompt clause, and a non-blocking post-hoc
  detector that could not prevent or fix anything and false-positived on ordinary productive
  phrasing. The Claude adversarial prefix itself remains always-on.

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
