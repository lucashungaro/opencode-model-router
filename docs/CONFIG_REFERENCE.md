# Enforcement Configuration Reference

Optional `enforcement` block in `tiers.json`. Fully additive — omitting the block (or setting `mode: "off"`) is a strict no-op; the plugin behaves byte-for-byte as without the block.

> These settings (like anything in `tiers.json`) can also be placed in an overrides file — `~/.config/opencode/opencode-model-router.overrides.jsonc` (global) or `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) — and are deep-merged over the bundled defaults, so you don't have to edit the cached `tiers.json`. See the **Configuration** section of the README.

**Cross-references:** [ENFORCEMENT.md](./ENFORCEMENT.md) · [VERIFICATION.md](./VERIFICATION.md) · [ESCALATION.md](./ESCALATION.md) · [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md)

---

## Top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"off" \| "advisory" \| "enforced"` | `"off"` | Global enforcement mode. `off` = no-op. `advisory` = log violations, never block. `enforced` = block/escalate on violations. |
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
| `require` | `"never" \| "whenDoDPresent" \| "always"` | `"whenDoDPresent"` | When to run a verification pass after production. |
| `requireExplicitDoD` | `boolean` | `false` | When `true`, a task with no explicit Definition of Done is treated as failing verification. |
| `preferDeterministic` | `boolean` | _(auto)_ | Defaults to `true` whenever the DoD contains runnable checks; omit to let the router decide. |
| `graderPolicy` | `"atLeastProducerTier"` | `"atLeastProducerTier"` | **Only valid value.** Grader tier = `max(producerTier, minGraderTier)` along the ladder; never below the producer. A deterministic check uses no grader. |
| `graderTemperature` | `number` | `0` | Applied via the `chat.params` hook to grader sessions only. |
| `minGraderTier` | `string` | _(none)_ | Optional floor for the grader tier, independent of producer. |

> **Note:** `graderPolicy: "atLeastProducerTier"` ensures a cheap producer is never graded by an even cheaper model. A deterministic DoD check (shell command, test run, lint) skips the grader entirely.

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

All fields are optional. An empty `{}` or omitted block is a no-op.
