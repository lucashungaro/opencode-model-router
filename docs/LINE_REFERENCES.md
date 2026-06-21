# Codebase module index

Reference index for maintainers. All paths relative to the package root. Reference by file + symbol name — no line numbers (they drift).

## Plugin entry

- **`src/index.ts`** — factory function; the sole export target. Exports `export default` (the factory) plus public types only. Named value exports break the opencode loader.

## Router

- **`src/router/config.ts`** — loads, validates, and caches the effective config. Layers, lowest→highest priority: bundled `tiers.json` → global overrides (`~/.config/opencode/opencode-model-router.overrides.jsonc`) → project overrides (`<repo>/.opencode/opencode-model-router.overrides.jsonc`, located by upward search) → persisted state. Also owns `deepMerge`, the per-section `validateConfig` helpers, and the `saveActivePreset`/`saveActiveMode`/`saveEnforcementMode` state writers.
- **`src/router/protocol.ts`** — builds the orchestrator delegation protocol string and tier system prompt strings, including Claude adversarial prefixes and anti-narration clauses.
- **`src/router/sessions.ts`** — tracks per-session state: tier, read-only call counts, cap overrides, enforcement context.
- **`src/router/enforcement.ts`** — reads enforcement config; decides whether a session is subject to enforcement and at what mode.
- **`src/router/catalog.ts`** — pure normalization/validation of opencode's live provider/model catalog (`config.providers()`); powers `/router models` and the stale/deprecated-model warnings. The async fetch lives in `index.ts`.
- **`src/router/jsonc.ts`** — pure, zero-dependency JSONC support (`stripJsonc`/`parseJsonc`): strips comments + trailing commas (string-aware) so the override files can use them.

## Commands (presentation)

- **`src/commands/output.ts`** — pure renderers for every slash command (`build*Output`/`build*List`/`build*Switched`/`buildAgentOptions`/etc.): config/data in → markdown string out, no state mutation. The `command.execute.before` handlers in `index.ts` decide + persist, then call these.

## Layer 1 — hard-block guard

- **`src/guard/guards.ts`** — top-level guard orchestrator; wires `tool.execute.before` decisions.
- **`src/guard/enforce.ts`** — enforcement decision engine; evaluates whether to throw, warn, or pass for a given tool call.
- **`src/guard/store.ts`** — per-session mutable guard state: call counts, fingerprints seen, bypass flags.
- **`src/guard/scrub.ts`** — sanitises tool arguments before fingerprinting to reduce false-positive redundancy hits.
- **`src/guard/fingerprint.ts`** — produces a stable canonical key for a tool call to detect redundant re-reads.
- **`src/guard/narration.ts`** — narration pattern detector; used by the `experimental.text.complete` hook.

## Layer 2 — independent acceptance gate

- **`src/verify/dod.ts`** — Definition-of-Done schema parser and builder; attaches a DoD block to delegation prompts.
- **`src/verify/deterministic.ts`** — cheap deterministic checks (exit code, file existence, output presence) run before grader dispatch.
- **`src/verify/checker.ts`** — orchestrates the full acceptance check sequence: deterministic → grader.
- **`src/verify/gate.ts`** — acceptance gate: accepts or rejects a result; emits structured `AcceptanceResult`.
- **`src/verify/dispatch.ts`** — dispatches the independent grader task at ≥ producer tier.
- **`src/verify/wiring.ts`** — the impure Layer-2 corner: `createVerificationWiring({ client, directory, getConfig })` bundles the exec/fs seams, grader-session dispatch, gate-deps builder, scorecard dump, and `extractAssistantText`. `index.ts` consumes `buildGateDeps()`/`dumpDelegateScorecard()`/`isGraderSession()`.
- **`src/verify/types.ts`** — shared types for the verify subsystem (`DoDBlock`, `AcceptanceResult`, `GraderRequest`, etc.).

## Layer 3 — quality-escalation ladder

- **`src/escalate/ladder.ts`** — escalation loop: retry → fast → medium → heavy, bounded by attempt and cost ceilings; emits final `status: met | unmet`.

## Telemetry

- **`src/telemetry/trajectory.ts`** — records per-session tool call trajectory for the `session.idle` dump. Record-only debug scaffolding: `index.ts` skips all recording unless `MODEL_ROUTER_TRAJECTORY_DEBUG=1`.

## Hooks registered by the factory (`src/index.ts`)

| Hook | Purpose |
|------|---------|
| `chat.params` | Pins grader temperature to 0 for deterministic acceptance calls. |
| `chat.message` | Subagent detection (matches `agent` field to registered tier names) + trivial task classification (skips DoD for one-liner lookups). |
| `tool.execute.before` | **Layer-1 hard-block**: throws on budget overruns, redundant reads, and throwaway-script sidesteps in enforced subagent sessions. |
| `tool.execute.after` | Cap banner injection + Layer-1 state update + Option (i) verify-dispatch (via `verifyDelegatedTask`, early-skips non-`task` tools) + trajectory recording (debug-gated). |
| `experimental.text.complete` | Narration banner: scans completed text for narration patterns and appends a visible warning. |
| `event` (`session.idle`) | Scorecard / trajectory dump at session end. |
| `config` | Registers tier agents (model, prompt, steps) and slash commands. |
| `experimental.chat.system.transform` | Injects delegation protocol + DoD section into the orchestrator system prompt. |
| `command.execute.before` | Handles `/tiers`, `/preset`, `/budget`, `/bypass`, and `/router` (subcommands: `enforce`, `overrides`, `models`, plus bare status with inline model-validation). `/annotate-plan` is a template-only command. |
| `tool: { delegate }` | Custom delegate tool (Option ii): authoritative delegation with full enforcement pipeline. |
