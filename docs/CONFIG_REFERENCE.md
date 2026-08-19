# Enforcement Configuration Reference

The `enforcement` block in `tiers.json`. Every field is optional; each one falls back to the default listed below, and the bundled `tiers.json` now **ships those defaults explicitly** so they are visible in the file rather than implicit in code — see [What the bundled `tiers.json` ships](#what-the-bundled-tiersjson-ships). Setting `mode: "off"` (or `MODEL_ROUTER_ENFORCE=0`) is a strict no-op.

> These settings (like anything in `tiers.json`) can also be placed in an overrides file — `~/.config/opencode/opencode-model-router.overrides.jsonc` (global) or `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) — and are deep-merged over the bundled defaults, so you don't have to edit the cached `tiers.json`. See the **Configuration** section of the README.

**Cross-references:** [ENFORCEMENT.md](./ENFORCEMENT.md) · [VERIFICATION.md](./VERIFICATION.md) · [ESCALATION.md](./ESCALATION.md) · [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md)

---

## Top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"off" \| "advisory" \| "enforced"` | `"advisory"` | Global enforcement mode. `off` = no-op. `advisory` = log violations, never block. `enforced` = block/escalate on violations. |
| `envGate` | `string` | `"MODEL_ROUTER_ENFORCE"` | Name of the env var that overrides mode at runtime. See env-gate truth table below. |
| `perTier` | `Record<string, "off" \| "advisory" \| "enforced">` | `{}` | Per-tier mode overrides. Keyed by tier name. Overrides base `mode` when the env gate is unset/empty. |
| `guard` | object | see below | Request-level hard guards (caps, script controls, budget). |
| `verify` | object | see below | Verification / grading policy. |
| `escalate` | object | see below | Escalation ladder and cost ceiling. |
| `proportional` | object | see below | Trivial-task bypass logic. |

---

## `guard`

| Field | Type | Default | Notes |
|---|---|---|---|
| `readDraftCap` | `number` | `3` | Max read-only tool calls before an edit must begin. |
| `sameOpRetryCap` | `number` | `1` | Max retries of the identical operation before escalation. |
| `blockSelfScript` | `boolean` | `true` | Block agent-written scripts that target the router's own config files. |
| `deliverableFirst` | `boolean` | `true` | Require a concrete deliverable token before prose commentary. |
| `budget` | `number` | `25` | Soft cost-unit ceiling per attempt. Must be ≥ 1. |
| `blockScriptWrites` | `boolean` | `false` | Block all script-write operations regardless of target. Must be a boolean. |

---

## `verify`

| Field | Type | Default | Notes |
|---|---|---|---|
| `require` | `"never" \| "whenDoDPresent" \| "always"` | _(unset)_ | When to run a verification pass after production. Has no code-level default: when the key is absent the call sites read `undefined` and decide per dispatch, so the bundled `tiers.json` ships nothing for it. |
| `requireExplicitDoD` | `boolean` | `false` | When `true`, a task with no explicit Definition of Done is treated as failing verification. |
| `preferDeterministic` | `boolean` | _(auto)_ | Defaults to `true` whenever the DoD contains runnable checks; omit to let the router decide. |
| `graderPolicy` | `"atLeastProducerTier"` | `"atLeastProducerTier"` | **Only valid value.** Grader tier = `max(producerTier, minGraderTier)` along the ladder; never below the producer. A deterministic check uses no grader. |
| `graderTemperature` | `number` | `0` | Applied via the `chat.params` hook to grader sessions only. |
| `minGraderTier` | `string \| null` | `null` | Optional floor for the grader tier, independent of producer. `null` means no floor and is identical to omitting the key. |
| `delegateTimeoutMs` | `integer ≥ 1` | `600000` (10 min) | Ceiling for **one** producer `session.prompt` turn in the `delegate` tool. Each ladder attempt gets its own budget. On expiry the child session is aborted and deleted, the attempt is recorded as failed with `producer failed: …`, and the ladder advances — the delegation never fabricates a pass. |
| `graderTimeoutMs` | `integer ≥ 1` | `60000` (1 min) | Ceiling for **one** grader `session.prompt` turn. On expiry the grader session is aborted and deleted and verification fails closed; there is no "inconclusive, therefore accepted" path. |
| `gateBudgetMs` | `integer ≥ 1` | `90000` (90 s) | Ceiling for the whole acceptance gate — deterministic checks plus the grader — for one attempt. On expiry any in-flight grader is aborted and the verdict is an honest `unmet`. |

> **Note:** `graderPolicy: "atLeastProducerTier"` ensures a cheap producer is never graded by an even cheaper model. A deterministic DoD check (shell command, test run, lint) skips the grader entirely.

> **Tuning the ceilings.** The 10-minute producer default is sized for a heavy-tier
> task that reads a codebase and writes a non-trivial patch, and it applies **per
> ladder attempt**, not per delegation. A genuinely long-running heavy task can
> still hit it — a large migration, or a task whose subagent shells out to a slow
> build. If that happens the symptom is unambiguous: `[router status: unmet]` with
> `producer failed: delegate producer prompt timed out after 600000ms` in the
> forcing note. Raise `delegateTimeoutMs` rather than removing the ceiling; `0` and
> negative values are **rejected at load** precisely so that "no timeout" cannot be
> requested by accident. `gateBudgetMs` bounds verification, not production, and
> should stay well under `delegateTimeoutMs`.

---

## `escalate`

| Field | Type | Default | Notes |
|---|---|---|---|
| `floorTier` | `string \| null` | `null` | Pin the minimum starting tier; skips cheaper rungs. Must be string or `null`. |
| `ladder` | `string[]` | `["fast","medium","heavy"]` | Ordered list of tier names to escalate through. Must be an array of strings. |
| `maxAttemptsPerTier` | `number` | `1` | Max attempts at each rung before advancing. Must be integer ≥ 0. |
| `maxTotalAttempts` | `number` | `4` | Hard ceiling across all tiers and retries. Must be integer ≥ 1. |
| `costCeiling.base` | `string` | `"firstAttemptCostUnits"` | Reference point for cost ceiling. `"firstAttemptCostUnits"` = cost of the first producing attempt. |
| `costCeiling.multiple` | `number` | `4` | Ceiling = `base × multiple`. Must be > 0. Escalation halts when cumulative cost would exceed this. |

> **`floorTier`** is useful when a task is known non-trivial: set `floorTier: "medium"` to skip `fast` entirely.  
> **`costCeiling`** is evaluated before each escalation step; the attempt is not started if it would breach the ceiling.

---

## `proportional`

| Field | Type | Default | Notes |
|---|---|---|---|
| `trivialBypass` | `boolean` | `true` | When `true`, tasks classified as trivial skip enforcement and route to `fast` directly. |
| `trivialClassifier` | `string` | `"dispatchIntent"` | Classifier strategy used to detect trivial tasks. |

> **Note:** `trivialBypass` defaults `true` but trivial classification is tier-gated to `fast` and biased toward non-trivial. Real work is never silently downgraded.

---

## Env-gate truth table

Env var name: value of `enforcement.envGate` (default `MODEL_ROUTER_ENFORCE`).  
Evaluated by `resolveEnforcementMode` on every dispatch.

| Env var value | Resolved mode | Notes |
|---|---|---|
| `"1"` | `"enforced"` | Hard override. Ignores `mode` **and** `perTier`. |
| `"0"` | `"off"` | Hard override. Ignores `mode`. |
| unset or `""` | config `mode`, with `perTier[tier]` taking precedence when present | Normal path. |
| any other value | config `mode` (fallback) | Emits one-time warning: `<gate>="<value>" is not "1" or "0"; ignoring env gate and using config.` |

---

## Validation rules

`validateConfig` throws on `tiers.json` load if any of these are violated:

| Rule |
|---|
| `mode` must be one of `off \| advisory \| enforced`. |
| `verify.graderPolicy` (when `verify` is an object) must be exactly `"atLeastProducerTier"`. |
| `escalate.costCeiling.multiple` must be a number > 0. |
| `escalate.ladder` must be an array of strings. |
| `escalate.maxAttemptsPerTier` must be an integer ≥ 0. |
| `escalate.maxTotalAttempts` must be an integer ≥ 1. |
| `escalate.floorTier` must be string or `null`. |
| `perTier` values must each be `off \| advisory \| enforced`. |
| `guard.budget` must be a number ≥ 1. |
| `guard.blockScriptWrites` must be a boolean. |
| `envGate` must be a non-empty string. |
| `guard.readDraftCap` and `guard.sameOpRetryCap` must each be an integer ≥ 0. |
| `guard.blockSelfScript` and `guard.deliverableFirst` must each be a boolean. |
| `verify.minGraderTier` must be a string or `null`. |
| `verify.graderTemperature` must be a number ≥ 0. |
| `verify.requireExplicitDoD` must be a boolean. |
| `verify.delegateTimeoutMs`, `verify.graderTimeoutMs` and `verify.gateBudgetMs` must each be an integer ≥ 1 (milliseconds). `0` and negatives are rejected, not read as "no timeout". |
| `proportional.trivialBypass` must be a boolean. |

An invalid value in the bundled `tiers.json` throws at load; the same value in an
overrides file is reported via `console.warn` and that override layer is dropped.

---

## What the bundled `tiers.json` ships

The bundled file ships an explicit `enforcement` block. **Every value in it equals the
default the code already applied when the key was absent**, so shipping it changed no
behaviour — it only makes the defaults readable and reviewable. `test/unit/enforcement-defaults.test.ts`
pins this: it resolves the real policies from the shipped file and from the same file with
`enforcement` deleted and requires the results to be identical.

| Field | Shipped value | Applied by |
|---|---|---|
| `mode` | `"advisory"` | `src/router/enforcement.ts` — violations are logged, never blocked |
| `envGate` | `"MODEL_ROUTER_ENFORCE"` | `src/router/enforcement.ts` (`DEFAULT_ENV_GATE`) |
| `guard.budget` | `25` | `src/guard/enforce.ts` (`DEFAULT_GUARD_BUDGET`) |
| `guard.readDraftCap` | `3` | `src/guard/enforce.ts` |
| `guard.sameOpRetryCap` | `1` | `src/guard/enforce.ts` |
| `guard.blockSelfScript` | `true` | `src/guard/enforce.ts` |
| `guard.deliverableFirst` | `true` | `src/guard/enforce.ts` |
| `guard.blockScriptWrites` | `false` | `src/guard/enforce.ts` |
| `verify.minGraderTier` | `null` | `src/verify/wiring.ts` |
| `verify.graderTemperature` | `0` | `src/index.ts` (`chat.params` hook, grader sessions only) |
| `verify.requireExplicitDoD` | `false` | `src/router/protocol.ts` |
| `verify.delegateTimeoutMs` | `600000` | `src/index.ts` (`delegate` producer prompt) |
| `verify.graderTimeoutMs` | `60000` | `src/verify/wiring.ts` (`dispatchGrader`) |
| `verify.gateBudgetMs` | `90000` | `src/index.ts` (`accept()` call in `delegate`) |
| `escalate.ladder` | `["fast","medium","heavy"]` | `src/escalate/ladder.ts` |
| `escalate.floorTier` | `null` | `src/escalate/ladder.ts` |
| `escalate.maxAttemptsPerTier` | `1` | `src/escalate/ladder.ts` |
| `escalate.maxTotalAttempts` | `4` | `src/escalate/ladder.ts` |
| `escalate.costCeiling.multiple` | `4` | `src/escalate/ladder.ts` |
| `proportional.trivialBypass` | `true` | `src/guard/enforce.ts` |

Fields deliberately **not** shipped, because no code reads them and a written-down value
would document a fiction: `verify.require` (no default — see above), `verify.graderPolicy`,
`verify.preferDeterministic`, `proportional.trivialClassifier`, and
`escalate.costCeiling.base`. These are validated when present but never consumed.

### `mode` defaults to `advisory`, and what `enforced` would change

With no `enforcement` block at all, the resolved mode is **`advisory`** — not `off`. In
advisory mode every guard, ladder and verification rule is evaluated and reported in the
scorecard, but nothing is ever blocked or retried.

Changing `mode` to `"enforced"` turns those same evaluations into actions:

- **Guards block.** A call that violates `readDraftCap`, `sameOpRetryCap`, `blockSelfScript`,
  `deliverableFirst`, `blockScriptWrites` or `budget` is refused instead of noted.
- **Verification gates acceptance.** A failed grader or deterministic check makes the
  delegation `unmet` rather than accepted-with-a-note.
- **The ladder escalates.** An `unmet` result retries and climbs `escalate.ladder`, bounded
  by `maxAttemptsPerTier`, `maxTotalAttempts` and `costCeiling.multiple` — which costs real
  tokens that advisory mode never spends.
- **`proportional.trivialBypass` starts mattering.** It only has an effect in `enforced`
  mode, where a task classified trivial is demoted back to advisory for that dispatch.

`MODEL_ROUTER_ENFORCE=1` produces the same effect at runtime without editing the file, and
`=0` forces `off`.

---

## How to enable

Three independent mechanisms; env gate always wins:

1. **Config** — set `enforcement.mode` in `tiers.json` (persisted, version-controlled).
2. **Env var** — `MODEL_ROUTER_ENFORCE=1` (forces `enforced`) or `=0` (forces `off`). Overrides config and `/router` state.
3. **Runtime command** — `/router enforce <off|advisory|enforced>` (written to the router state file; env gate still overrides).

---

## Minimal example

```jsonc
// tiers.json (enforcement block only; all other tier config omitted)
{
  "enforcement": {
    "mode": "advisory",
    "envGate": "MODEL_ROUTER_ENFORCE",
    "perTier": {
      "fast": "off"
    },
    "guard": {
      "readDraftCap": 5,
      "budget": 50,
      "blockScriptWrites": false
    },
    "verify": {
      "require": "whenDoDPresent",
      "graderPolicy": "atLeastProducerTier",
      "graderTemperature": 0
    },
    "escalate": {
      "floorTier": null,
      "ladder": ["fast", "medium", "heavy"],
      "maxAttemptsPerTier": 1,
      "maxTotalAttempts": 4,
      "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 4 }
    },
    "proportional": {
      "trivialBypass": true,
      "trivialClassifier": "dispatchIntent"
    }
  }
}
```

All fields are optional. An empty `{}` or omitted block resolves to the defaults above.
Note this example is **not** the bundled block: `readDraftCap: 5`, `budget: 50` and the
`perTier` override are illustrative non-default values. For what actually ships, see
[What the bundled `tiers.json` ships](#what-the-bundled-tiersjson-ships).
