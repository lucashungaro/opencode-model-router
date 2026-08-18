# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`subagentTiers`, opt-in routing for your own subagents.** A map of agent name to
  tier name repoints pre-existing custom subagents at the active preset's models, so
  they follow `/preset` instead of pinning a model id in their own agent files. A
  subagent that declares no `model` otherwise inherits the model of whoever invoked it,
  which quietly runs cheap read-only helpers at orchestrator prices. Absent or empty
  means no agent is touched.

### Fixed

- **Enforced-mode hard blocks now apply to non-trivial `@fast` recon.** Trivial
  classification exempted *any* `fast`-tier dispatch whose text matched a `fast`
  taskPattern stem (`read`, `search`, `grep`, …) from enforcement, so a multi-file
  recon dispatch was treated as "trivial" and `guardBeforeCall` downgraded
  `enforced` → `advisory`. The `read_budget` guard could therefore never
  hard-block a `@fast` subagent — the precise runaway it exists to bound.
  `classifyTrivial` now additionally requires single-shot shape: at most one named
  file path (well-known extensionless files like `Makefile` or `LICENSE` count),
  no multi-step marker (numbered or colon-numbered lists, sequencing words, `;`,
  `&&`), no enumeration of three or more subjects, no multiple imperative lines,
  and a length backstop. Genuine single-shot lookups stay exempt, and real work
  was never trivial either way. Present since
  proportional enforcement landed (`80abf05`) and shipped in every release that
  included it. The `enforcement.proportional.trivialBypass` knob and its semantics
  are unchanged.

## [1.6.0] - 2026-08-18

Minor release: a salvage port of the features worth keeping from an abandoned branch —
per-tier reasoning effort, goal-oriented prompts, session-resume accounting, time-boxes
on every verification hop, and idle eviction for the delegation store. Routing behavior
is unchanged unless you opt into the new keys.

### Added

- **Per-tier `effort`.** Each tier may declare a reasoning-effort level that is forwarded
  to the provider on dispatch. The bundled `fable-effort` preset uses it to run all three
  tiers on the same model at different effort levels, so the cost ladder comes from
  reasoning depth rather than model size.
- **Goal-oriented prompt styles.** `promptStyle` (`auto` | `prescriptive` | `goal-oriented`),
  `modelGenerations`, and `tierPromptsGoalOriented` let a tier ship a goal-oriented prompt
  instead of the terse rule list. Under `auto` a tier switches to the goal-oriented text
  when its model matches a declared newer generation; everything else keeps the prescriptive
  prompt.
- **Session-resume accounting.** A resumed session no longer restarts its budget: the
  cumulative ceiling carries across resumes, and registration now returns a `RegisterResult`
  so callers can see whether a dispatch was newly counted or replayed.
- **Time-boxes on delegate, grader, and gate.** `delegateTimeoutMs` (default 600000),
  `graderTimeoutMs` (default 60000), and `gateBudgetMs` (default 90000) bound each hop.
  They are fail-closed: a hop that runs out of budget is reported as unmet, never as
  silently satisfied.
- **Idle-TTL eviction for the delegation store.** Entries idle for more than an hour are
  swept, throttled to at most one sweep every five minutes. The sweep is timer-less — it
  piggybacks on store access — so it adds no background handles and nothing to unref in
  tests.
- **`cwd`-scoped verification.** A delegation may carry a `cwd`, which scopes the
  deterministic file checks and the grader's session lookup to that directory.
- **Evidence-grounding clauses in the medium and heavy tier prompts.** Subagents are told
  to check each reported claim against a tool result from the same session and to say so
  explicitly when a claim is unverified.
- **An explicit `enforcement` block in `tiers.json`.** Every key is now written out at the
  value that was previously the effective default, so the shipped behavior is unchanged and
  readable rather than implicit. `validateEnforcement` type-checks every shipped key.

### Changed

- **`CAP:none` now requires a `reason:` line.** A dispatch that says `CAP:none` without a
  `reason:` line in its text falls back to the tier's baseline cap instead of lifting it.
  The protocol states this in two places (rule 7 and the per-dispatch paragraph), which is
  the whole of this release's prompt growth: the routing protocol goes from 2,970 to 3,089
  characters, and the Claude and enforcement paths grow by the same 119 characters. See the
  token-overhead table in the README.
- **Under `promptStyle: "auto"`, some bundled tiers switch to goal-oriented prompts.** Tiers
  whose model is `claude-fable-5` or `claude-opus-4-8` — `anthropic.heavy`, `hybrid.heavy`,
  and all three `fable-effort` tiers — now receive the goal-oriented text. Set
  `promptStyle` to `prescriptive` to keep the previous prompts.

### Fixed

- **Child-session disposal is idempotent.** Disposing a session that was already disposed
  is a no-op instead of throwing.
- **Gate-timeout aborts are scoped per delegation.** A gate that runs out of budget aborts
  only its own delegation; concurrent delegations are no longer cancelled with it.
- **`fileExists` reasons are honest about absolute paths.** The reason string reports the
  path that was actually checked rather than the relative form that was passed in.
- **No more orphan `lastTouch` entries.** Touch records are removed with their delegation
  instead of accumulating for the lifetime of the process.

### Deliberately not ported

Several things from the source branch were left behind on purpose. The **lessons memory store**
(~800 lines) has no measurement behind it — if it is revisited it must arrive opt-in and
default-false rather than as a new always-on subsystem. The **anti-context-anxiety clause**,
the **INTENT section**, and the **workspace-root line** would re-add the prose that [#21]
deliberately removed. Flipping `activePreset` to `"opus"` would change the default for every
user, and flipping `enforcement.mode` to `"enforced"` would turn an advisory layer into a
blocking one; both stay as they are. `src/guard/smoke-evidence.ts` is test-support only and
carries no runtime behavior, so it was left as optional and not ported.

### Credits

Refactors [#26], [#27], and [#28] by Lucas Húngaro were merged while this port was in
progress, and the ported code is built on top of them.

[#26]: https://github.com/marco-jardim/opencode-model-router/pull/26
[#27]: https://github.com/marco-jardim/opencode-model-router/pull/27
[#28]: https://github.com/marco-jardim/opencode-model-router/pull/28

## [1.5.0] - 2026-08-18

Minor release: update-safe configuration overrides, so customizations survive the plugin
updates that overwrite the cached package file.

### Added

- **Update-safe config overrides.** `~/.config/opencode/opencode-model-router.overrides.jsonc`
  (global) and `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) are
  deep-merged over the bundled `tiers.json` — specify only the keys you want to change.
  The project file is located by searching upward to the repo root and wins over the
  global file, which wins over the bundled defaults. Models, tiers, and whole presets can
  now be customized without editing the cached package file, which every plugin update
  overwrites. An overrides file can also define an entirely new preset — `model` is the
  only required field per tier: `costRatio`/`steps` default to the conventional `1`/`5`/`20`
  and `30`/`50`/`120` by tier name when omitted, and `description`/`whenToUse` are optional.
  Contributed by Lucas Húngaro. ([#22], closes [#2] and [#4])
- **JSONC in the override files.** `//` and `/* */` comments and trailing commas are
  accepted, via a small zero-dependency parser (`src/router/jsonc.ts`). No new runtime
  dependencies.
- **`/router overrides`** — prints the global and project override paths, which of them
  exist, and the merge precedence.

### Fixed

- **The upward search for the project override file is now bounded.** It stops at a
  `.git`, `.hg`, or `.svn` marker, at 16 levels above the working directory, or at the
  user's home directory. A tree containing no repo marker previously walked all the way
  to the filesystem root, so running opencode from a non-repo directory could silently
  adopt an unrelated ancestor's override file. `package.json` is deliberately not treated
  as a repo marker: in a monorepo it would stop the walk at `packages/<pkg>/` before
  reaching the repo-root `.opencode/`. ([`8710a84`])

[`8710a84`]: https://github.com/marco-jardim/opencode-model-router/commit/8710a84
[#2]: https://github.com/marco-jardim/opencode-model-router/issues/2
[#4]: https://github.com/marco-jardim/opencode-model-router/issues/4
[#22]: https://github.com/marco-jardim/opencode-model-router/pull/22

## [1.4.0] - 2026-08-18

Minor release: session lifecycle fixes, more reliable read-only delegation, and a
smaller routing protocol with measured overhead documentation.

### Fixed

- **Grader and producer child sessions are now parented and disposed.** The plugin
  previously created backend sessions for every grader and producer attempt but never
  aborted or deleted them, including on the happy path, leaving orphaned top-level
  sessions in the TUI. ([`40c9b94`])
- **Layer-2 grading now skips read-only research delegations** when the DoD is inferred,
  checker-only, and no files changed. This prevents false "not accepted" notes on
  legitimate research results. Contributed by Lucas Húngaro. ([#20])
- README prompt-overhead figures now use measured character counts and explicit token
  estimate ranges. The previous `~210 tokens` claim understated the former default
  Claude path by roughly eight to nine times.

### Added

- A drift test now pins the acceptance-check grammar shared by the `/annotate-plan`
  template, `parseAcceptanceBlock`, and the delegation protocol. ([`19171ea`])

### Changed

- **The delegation protocol was rewritten without dropping routing rules.** On the
  default Claude path it is 46.6% smaller, from 7,006 to 3,742 characters. Contributed
  by Lucas Húngaro. ([#21])
- **The anti-narration guardrail is now opt-in.** Set the top-level `antiNarration`
  boolean to `true` to restore the prompt clause and detector; the default is `false`.
  ([#21])
- The package now declares Node.js 20 or later through `engines.node`. ([`6fa9bab`])

[`19171ea`]: https://github.com/marco-jardim/opencode-model-router/commit/19171ea
[`40c9b94`]: https://github.com/marco-jardim/opencode-model-router/commit/40c9b94
[`6fa9bab`]: https://github.com/marco-jardim/opencode-model-router/commit/6fa9bab
[#20]: https://github.com/marco-jardim/opencode-model-router/pull/20
[#21]: https://github.com/marco-jardim/opencode-model-router/pull/21

## [1.3.1] - 2026-08-16

Patch release: bug fixes, documentation, and release-engineering only. No runtime
behaviour changes beyond the corrected `github-copilot` model identifiers.

### Fixed

- **`github-copilot` preset model IDs** now use the dot-separated form the provider
  actually serves (`claude-haiku-4.5`, `claude-sonnet-4.6`, `claude-opus-4.6`) instead of
  the dash-separated variants, and the non-existent `/thinking` suffix has been dropped
  from the `@heavy` tier. Delegations under this preset previously referenced models that
  could not be resolved. ([#10], fixes [#9])
- Golden snapshot for the `github-copilot` delegation protocol realigned with the
  corrected identifiers above.

### Added

- **Continuous integration.** A `Test` workflow runs `npm ci`, the full suite, and
  `npm run typecheck` on Node 24 for every pull request and every push to `master`.
- **Automated publishing via npm Trusted Publishing (OIDC).** Pushing a `v*` tag builds
  and publishes from GitHub Actions with SLSA provenance attestation and no long-lived
  npm token. Third-party actions are pinned by commit SHA.
- **`package-lock.json` is now tracked**, making installs reproducible across
  contributors and CI. It is not included in the published tarball.

### Changed

- README install and configuration instructions corrected and expanded, including how the
  `tiers.json` cache behaves. ([#7])
- Development dependencies `vitest` and `@vitest/coverage-v8` upgraded to 4.x. Both are
  bumped in lockstep because `@vitest/coverage-v8` pins an exact `vitest` peer; Dependabot
  is now configured to group them. Dev-only — no effect on the published package. ([#8])

[#7]: https://github.com/marco-jardim/opencode-model-router/pull/7
[#8]: https://github.com/marco-jardim/opencode-model-router/pull/8
[#9]: https://github.com/marco-jardim/opencode-model-router/issues/9
[#10]: https://github.com/marco-jardim/opencode-model-router/pull/10

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
