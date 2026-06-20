# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An [OpenCode](https://opencode.ai) plugin (single npm package, ESM, TypeScript run directly — no build step). It injects a compressed "delegation protocol" into the orchestrator's system prompt on every message so the orchestrator routes each task to the cheapest adequate tier (`@fast`/`@medium`/`@heavy`), and it enforces delegation discipline through hook-based guards. The plugin's runtime entry is `src/index.ts` (referenced as `main` in `package.json`); OpenCode loads it via the `@opencode-ai/plugin` peer dependency.

## Commands

```bash
npm test                  # vitest run — full unit/integration suite (excludes smoke)
npm run test:watch        # vitest watch mode
npm run test:coverage     # run with v8 coverage + thresholds (see vitest.config.ts)
npm run typecheck         # tsc --noEmit
npm run smoke             # opt-in real-OpenCode smoke tests (gated by RUN_OC_SMOKE=1)

# single test file
npx vitest run test/unit/protocol.test.ts
# single test by name
npx vitest run -t "name fragment"
# a single smoke test (needs the smoke config — it un-excludes test/smoke/**)
RUN_OC_SMOKE=1 npx vitest run --config vitest.smoke.config.ts test/smoke/guard-hardblock.smoke.test.ts
```

There is no lint script and no build/bundle step — the package ships raw `src/` TypeScript.

## Critical conventions

- **Tests NEVER live under `src/`.** They live in top-level `test/` so the published tarball (`files: ["src/", ...]`) can never ship tests. Tests import from specific source files (e.g. `./src/router/protocol`), **not** from `src/index.ts`.
- **`src/index.ts` exports only types, plus `default` (the plugin factory).** OpenCode's plugin loader calls *every* function-valued export as a factory (it iterates `Object.values(mod)`). Adding a named `function`/value export would trigger spurious factory invocations. Keep value logic in submodules; re-export types only.
- **Submodules under `src/guard/`, `src/verify/`, `src/escalate/`, `src/telemetry/` are PURE** — no `fs`, network, SDK, or `process.env`. Side effects are injected via `deps` objects. Coverage thresholds enforce this design (guard/verify/router ≥90% branch, escalate/telemetry ≥95%). Keep these modules pure when editing.
- **Never mutate `tiers.json` from code.** User selections (preset, mode, enforcement) persist to a separate state file at `~/.config/opencode/opencode-model-router.state.json` (see `statePath()` / `writeState()` in `src/router/config.ts`). After writing state, call `invalidateConfigCache()` so the next `loadConfig()` re-reads it.
- **Config layering, merged in `loadConfig()`** (lowest→highest priority): bundled `tiers.json` → global overrides `~/.config/opencode/model-router-overrides.json` (`overridePath()`) → project overrides `.opencode/model-router-overrides.json` (found by `findProjectOverride()`, which walks up from `cwd` to the repo root / nearest `.git`; `localOverridePath()` is just the default create-location for display) → state file overlay (active preset/mode/enforcement). The two override files let users customize models/tiers without editing the cached package file; project wins over global so a committed project file unifies team routing. Each override layer read/parse failure `console.warn`s and is skipped; if the combined merge fails validation, `loadConfig` drops conflicting layers (preferring to keep the higher-priority one) and falls back toward bundled defaults — never throws, so a bad override can't brick startup. `deepMerge` recurses into plain objects and replaces arrays/scalars. `/router overrides` prints both paths + precedence.

## Architecture

`tiers.json` (plugin root) is the entire configuration surface: presets (anthropic/openai/github-copilot/google), tier models + `costRatio`, `modes` (normal/budget/quality/deep), `rules`, `taskPatterns`, `tierCaps`, `tierPrompts`, `fallback`, and `enforcement`. `src/router/config.ts` loads, validates (strict, throws on malformed `tiers.json`), and caches it. Effective config = `tiers.json` overlaid with the persisted state file (active preset/mode/enforcement).

The plugin is wired entirely through OpenCode hooks returned by the factory in `src/index.ts`:

- **`config`** — at load time, registers a tier *agent* per tier and the slash commands (`tiers`, `preset`, `budget`, `bypass`, `annotate-plan`, `router`). Command bodies are handled in `command.execute.before`.
- **`experimental.chat.system.transform`** — injects the compressed delegation protocol into the orchestrator system prompt. **Skipped for subagent sessions** (otherwise subagents try to call the nonexistent `Task` tool). Adds Claude-specific adversarial/anti-narration prefixes when the session model is a Claude identifier (`isClaudeModel`).
- **`chat.message`** (NOT `chat.params`) — detects subagent sessions by matching `input.agent` against a registered tier name and records the sessionID. This must run before `system.transform`; the OpenCode order is `chat.message → system.transform → chat.params`, so doing it in `chat.params` is one step too late. See the long comment at `src/index.ts:623`.
- **`tool.execute.before`** — Layer-1 hard-block guard (`src/guard/`). Only active for subagent sessions when enforcement is `advisory`/`enforced`; throws to abort a disallowed tool call. Orchestrator sessions are never hard-blocked.
- **`tool.execute.after`** — appends read-only cap banners (`[cap: N/M]`, warnings, `[⚠ REDUNDANT]`) to grep/read/glob/ls results for tracked subagent sessions (`src/router/sessions.ts`).
- **`experimental.text.complete`** — post-hoc narration detector (`src/guard/narration.ts`); appends a `[⚠ narration detected: ...]` banner, non-blocking.

### Module map

- `src/router/` — config loading/validation (`config.ts`), protocol assembly + Claude detection/prefixes (`protocol.ts`), enforcement-mode resolution (`enforcement.ts`), subagent session tracking + cap banners (`sessions.ts`), model-catalog normalization/validation/suggestions (`catalog.ts`, pure — the async `client.config.providers()` fetch lives in `index.ts`).
- `src/guard/` — Layer 1. `guards.ts` (pure policy eval), `enforce.ts` (before/after orchestration), `store.ts` (per-session state), `fingerprint.ts` (tool-call dedup), `narration.ts`, `scrub.ts`.
- `src/verify/` — Layer 2 acceptance gate. `gate.ts` is the single accept/verify decision point (fail-closed; producer ≠ grader; grader ≥ producer tier). `dod.ts` (Definition-of-Done schema), `deterministic.ts`, `checker.ts` (graded), `dispatch.ts`, `types.ts`.
- `src/escalate/` — Layer 3 quality-escalation ladder (retry → fast→medium→heavy, bounded by attempt/cost ceilings).
- `src/telemetry/trajectory.ts` — per-subagent scorecard (record-only).

### Three enforcement layers / two modes

Enforcement (`enforcement.mode` in `tiers.json`) is `advisory` by default (verifies + surfaces forcing-notes, never blocks). `off` = byte-for-byte-unchanged routing, zero added tokens. `enforced` = hard-blocks active. Env `MODEL_ROUTER_ENFORCE=1|0` overrides config; `/router enforce <off|advisory|enforced>` toggles at runtime. **Enforcement applies to subagent/delegate sessions only — never the orchestrator.**

Two usage modes: **Mode A** (on-the-fly) delegates via the native `Task()` tool, observed/verified automatically. **Mode B** (plan-annotated) wires the loop from `[tier:X]` + `[acceptance]` tags emitted by `/annotate-plan`. An optional plugin-owned `delegate` tool is hidden unless `experimental.verifiedDelegateTool` (or `MODEL_ROUTER_VERIFIED_DELEGATE=1`) is set.

## Where to look first

- Routing protocol wording / token budget → `src/router/protocol.ts` (`buildDelegationProtocol`, `assembleSystemPrompt`).
- Adding/changing a preset, mode, cap, or rule → `tiers.json` + its validator in `src/router/config.ts`.
- Hook behavior / plugin lifecycle → `src/index.ts` (factory return object).
- Deep-dives (not in the npm tarball): `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`, `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`, `docs/ENFORCEMENT_PRESETS.md`.
