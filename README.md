# opencode-model-router

> **Automatically use the cheapest model that can do the job.**

An [OpenCode](https://opencode.ai) plugin that routes every coding task to the right-priced AI tier, automatically, on every message.

## Main features and characteristics

Most AI coding tools give you one model for everything, meaning you pay frontier prices for things like running a simple `grep`. The opencode-model-router plugin changes that with a stack of instructions, guardrails and tools:

**Use a mid-tier model as orchestrator.**
The orchestrator runs on *every* message. You should use a mid-tier model for this (just set it as your default model for Opencode). That model reads a routing protocol and delegates work just as well as any top-tier model at much lower cost. Reserve the top-tier models for when it genuinely matters. For example, when using Anthropic models, the orchestrator should be Sonnet, not Opus.

**Inject the routing protocol on every message.**
The orchestrator gets the tier taxonomy, routing rules, and (when enforcement is on) the acceptance contract in its system prompt every turn. That overhead is currently around 1.4k to 2k tokens depending on the orchestrator model and enforcement mode (see [Token overhead](#token-overhead)), while saving many times over by routing the turn's work to a cheaper tier when possible.

**Match task to tier using a configurable taxonomy.**
A compact keyword routing guide (`@fast→search/grep/read`, `@medium→impl/refactor/test`, `@heavy→arch/debug/security`) tells the orchestrator exactly which tier fits each task type. Fully customizable.

**Split separable composite tasks: explore cheaply, execute efficiently.**
"Find how auth works and refactor it" shouldn't cost @medium for the whole thing. The multi-phase guidance prefers a split when phases are separable: @fast reads the files (1x cost), @medium does the rewrite (5x cost). The goal is to get significant savings on composite tasks, representing realistic coding sessions (many turns mixing exploration, writing code, running tests, debugging etc).

**Skip delegation overhead for trivial work.**
Single grep? One file read (or a quick follow-up)? The orchestrator can execute directly to avoid extra delegation cost and latency.

**Four routing modes for different budgets.**
`/budget normal` (balanced), `/budget budget` (aggressive savings, defaults everything to @fast), `/budget quality` (liberal use of stronger models), `/budget deep` (heavy-first for long architecture/debug runs). Mode persists across restarts.

**Cost ratios in the prompt.**
Every tier carries its `costRatio` (e.g., fast=1x, medium=5x, heavy=20x) injected into the system prompt. The orchestrator sees the price before deciding. It picks the cheapest tier that can reliably handle the task.

**Orchestrator-awareness.**
If the orchestrator is already running on Opus, the rule `self∈opus→never→@heavy` fires. It does the heavy work itself rather than delegating to another Opus instance.

**Multi-provider support with automatic fallback.**
Five presets out of the box: Anthropic, OpenAI, GitHub Copilot, Google, and a mixed-provider Hybrid. If a provider fails, the fallback chain tries the next one automatically. You can switch presets using the `/preset` command, or add your own preset in an overrides file.

**Plan annotation for long tasks.**
`/annotate-plan` reads a markdown plan and tags each step with `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]`, removing all routing ambiguity from multi-step workflows.

**Fully configurable.**
Tiers, models, cost ratios, rules, task patterns, routing modes, quality enforcement, fallback chains can be configured using an overrides file. You can also add a new preset for a provider not included in the defaults.

## The problem

Coding with AI can get expensive when the coding tools default to one model for everything. That model is usually the most capable available, and you pay for that capability even when the task is "grep for a function name".

A typical coding session breaks down roughly like this:

| Task type | % of session | Example |
|-----------|-------------|---------|
| Exploration / search | ~40% | Find where X is defined, read a file, check git log |
| Implementation | ~45% | Write a function, fix a bug, add a test |
| Architecture / deep debug | ~15% | Design a new module, debug after 2+ failures |

If you're running Opus or GPT 5.5 for all of it, you're overpaying significantly on most tasks.

## The solution

`opencode-model-router` injects a **delegation protocol** into the system prompt that teaches the orchestrator to:

1. **Match task to tier**: using a configurable task taxonomy
2. **Split composite tasks**: explore first with a cheap model, then implement with a mid-tier model
3. **Skip delegation overhead**: for trivial tasks (1-2 tool calls) use the orchestrator directly
4. **Never over-qualify**: use the cheapest tier that can reliably handle the task
5. **Fallback**: if a provider/model is unavailable, try another option

This protocol is injected into the system prompt on every message. The overhead is currently around 1.4k to 2k tokens depending on your orchestrator model and enforcement mode (see [Token overhead](#token-overhead)).

The plugin also adds:

- An optional **enforcement layer** that checks whether delegated work actually meets the agreed-upon definition of "done" (tests pass, file exists, etc.) and nudges or blocks subagents that fail to meet it.
- Read-only call caps on subagents to prevent runaway reconnaissance loops and redundant tool calls.
- A **plan annotation** command that tags each step of a multi-step plan with the appropriate tier, so the orchestrator knows exactly how to route each step.
- Claude-model adversarial prefixes (always on for Claude), plus an optional anti-narration guardrail (off by default).
- A budget setting that lets you lean routing toward balance, savings, quality, or deep analysis.

## Understanding how it works

There are a lot of moving parts, so let's use an analogy to explain how the plugin works.

### Picking who does the work

Think of your main orchestrator model as a head chef in a restaurant. You give it an order, and instead of cooking everything itself, it hands tasks to line cooks of different skill and price: a fast, cheap cook for simple tasks, a mid-level cook for everyday work, and an expensive expert for the hard problems.

The chef assigns each task by what the task is, not by who is the "fanciest" cook. Reading a file, searching the codebase, or looking something up goes to the cheap cook. Writing and editing code goes to the mid-level cook. Gnarly architecture, security work, or debugging that has already failed a couple of times goes to the expert. Trivial one-off lookups the chef just handles itself, since delegating those would cost more than it saves.

That is the routing in a nutshell. You pay expert prices only when a task genuinely needs an expert, which is exactly the point.

### Making sure the work actually got done

The enforcement layer is the kitchen's quality control. It exists because a cook saying "all done" is not the same as the dish being good.

It works in two parts. First, a recipe card travels with each order, so the chef and the cook agree up front on what "done" means (say, the tests pass, or a specific file exists). Second, when the work comes back, someone other than the cook who made it tastes it, and that taster is at least as senior as the cook who executed it. They check it against the recipe card, and if it falls short, a note goes back to the chef suggesting a redo, maybe by a more capable cook.

How strict all of this is comes down to one setting:

- **Off:** no checking. A cook says done and it goes out.
- **Advisory (the default):** everything still gets tasted and notes still get left, but nothing is ever held back. Gentle nudges only.
- **Enforced:** a dish that fails its check is held back and redone, or handed to a better cook, before it can leave the kitchen.

You can disable the enforcement layer entirely to save some tokens in the system prompt, at the cost of possible re-work if a subagent fails to meet the agreed-upon definition of "done." This is the enforcement feature.

### The standing rule: limited trips to the pantry

Separate from that optional quality control, the kitchen has one rule that is always in force, no matter which setting above you pick: a cook only gets so many trips to the pantry on a given task before they have to either start cooking or hand back what they have so far. And if a cook keeps checking the same shelf over and over, they get a sticky note telling them to stop. This is not about whether the dish is any good, it just keeps anyone from vanishing into the walk-in for an hour of "research" instead of producing something. It applies even with enforcement layer turned off.

This is the read-only call cap feature. It prevents runaway "exploration" loops and redundant tool calls, which are a common source of wasted time and money.

### Planning a big job up front

For a large, multi-step job you do not have to let the chef work out each step on the fly. You can write the plan down and have the kitchen label every step on the ticket ahead of time with the cook who should handle it. Think of prepping a banquet where each course is pre-assigned to a station, so nobody is deciding in the middle of service.

This is the plan annotation feature. You can invoke it with `/annotate-plan`. More details in [Plan annotation](#plan-annotation).

### Keeping certain cooks on task

Some cooks arrive with strong habits from their previous job. Left alone they tend to wander the whole pantry "just to be thorough," or they announce what they are about to do ("now I'll dice the onions") instead of actually doing it.

For those cooks the plugin clips a short note to the top of their instructions: in this kitchen your job is the dish in front of you, not a tour of the pantry. It keeps them from burning time and money on busywork. This is the adversarial prefix. There is also an optional, off-by-default add-on (the anti-narration guardrail) that tells them to cook rather than describe cooking; turn it on only if a cook keeps announcing dishes without plating them.

### Setting the kitchen's priorities

You can also tell the kitchen how to lean. One setting keeps things balanced, one pushes hard for savings and sends almost everything to the cheap cook (with the obvious quality trade-offs), one spends more freely when you want quality, and one goes expert-first for long, hard jobs. You also choose which suppliers the cooks come from (Anthropic, OpenAI, Google, GitHub Copilot, or a mix), and if a supplier is unavailable the kitchen falls back to another automatically. These are the budget modes, presets, and fallback chain features.

In summary, the chef decides who cooks, the quality control decides whether the finished plate is good enough to serve, and the remaining knobs let you set the kitchen's budget, priorities, and suppliers.

## Cost simulation

**Scenario: 50-message coding session with 30 delegated tasks**

Task distribution: 18 exploration (60%), 10 implementation (33%), 2 architecture (7%)

### Without model router (all-Opus)

| Task | Count | Tier | Cost ratio | Total |
|------|-------|------|-----------|-------|
| Exploration | 18 | Opus | 20x | 360x |
| Implementation | 10 | Opus | 20x | 200x |
| Architecture | 2 | Opus | 20x | 40x |
| **Total** | **30** | | | **600x** |

### With model router (normal mode, Sonnet orchestrator)

| Task | Count | Tier | Cost ratio | Total |
|------|-------|------|-----------|-------|
| Exploration (delegated) | 10 | @fast | 1x | 10x |
| Exploration (direct, trivial) | 8 | self | 0x | 0x |
| Implementation | 10 | @medium | 5x | 50x |
| Architecture | 2 | @heavy | 20x | 40x |
| **Total** | **30** | | | **100x** |

### With model router (budget mode, Sonnet orchestrator)

| Task | Count | Tier | Cost ratio | Total |
|------|-------|------|-----------|-------|
| Exploration | 18 | @fast | 1x | 18x |
| Implementation (simple) | 7 | @fast | 1x | 7x |
| Implementation (complex) | 3 | @medium | 5x | 15x |
| Architecture | 2 | @medium | 5x | 10x |
| **Total** | **30** | | | **50x** |

### Summary

| Setup | Session cost | vs all-Opus |
|-------|-------------|-------------|
| All-Opus (no router) | 600x | baseline |
| Sonnet orchestrator + router (normal) | 100x | **−83%** |
| Sonnet orchestrator + router (budget) | 50x | **−92%** |

> Cost ratios are relative units. Actual savings depend on your provider pricing and model selection. This is a simulated scenario, not a real measurement.

## Inner workings

On every message, the plugin injects the delegation protocol into the orchestrator's system prompt. It encodes the tier taxonomy, routing rules, per-tier guidance, and (when enforcement is on) the acceptance contract. Current size is roughly 1.4k to 2k tokens depending on the orchestrator model and enforcement mode; see [Token overhead](#token-overhead) for the breakdown and the levers that shrink it.

The routing grammar at the heart of it, abridged for readability (the full injected text also carries a `HARD ROUTING` block, per-tier contracts, and the acceptance section):

```
## Model Delegation Protocol
Preset: anthropic. Tiers: @fast=claude-haiku-4-5(1x) @medium=claude-sonnet-4-6/max(5x) @heavy=claude-opus-4-8/max(20x). mode:normal
R: @fast→search/grep/read/git-info/ls/lookup-docs/types/count/exists-check/rename @medium→impl-feature/refactor/write-tests/bugfix(≤2)/edit-logic/code-review/build-fix/create-file/db-migrate/api-endpoint/config-update @heavy→arch-design/debug(≥3fail)/sec-audit/perf-opt/migrate-strategy/multi-system-integration/tradeoff-analysis/rca
Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable. Cheapest-first when practical.
1.[tier:X] tag in plan→delegate X 2.plan:fast/cheap→@fast | plan:medium→@medium | plan:heavy→@heavy 3.default preference: read-only→@fast | implementation→@medium 4.orchestrate=self,execute=subagent 5.trivial(≤1 tool call,no expected follow-up)→direct,skip-delegate 6.before @heavy: gather context first(usually via @fast); if already sufficient, dispatch directly 7.if self is opus: skip-@heavy(do locally), still route broader read-only exploration to @fast 8.min(cost,adequate-tier)
Err→retry-alt-tier→fail→direct. Chain: anthropic→openai→google→github-copilot
Delegate with Task(subagent_type="fast|medium|heavy", prompt="...").
Keep orchestration and final synthesis in the primary agent.
```

**What each line means:**

| Line | What it encodes |
|------|----------------|
| `Tiers: @fast=...(1x) @medium=...(5x) @heavy=...(20x)` | Model + cost ratio per tier, all in one compact token |
| `R: @fast→search/grep/... @medium→impl/...` | Full task taxonomy with keyword triggers for each tier |
| `Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable` | Preferred decomposition for separable composite tasks |
| `1.[tier:X]→... 5.trivial(≤1 tool call)... 6.before @heavy: gather context...` | Numbered routing rules in abbreviated form |
| `Err→retry-alt-tier→fail→direct. Chain: anthropic→...` | Fallback strategy in one line |

The orchestrator reads this once per message and applies it to every tool call and delegation decision in that turn.

### Multi-phase decomposition

This is the most impactful optimization. For example, in a medium sized app, a composite task consuming about 8K tokens might be:

> "Find how the auth middleware works and refactor it to use JWT."

Without the router: we could execute entirely with a "medium" model (5x for all ~8K tokens) or "heavy" model (20x for all ~8K tokens).

With the router, the orchestrator sees that the task is separable into two phases: exploration (grep, read files, trace call chain) and execution (rewrite auth module). It routes the first phase to a "fast" model (1x) and the second phase to a "medium" model (5x), saving significant cost.
- **@fast (1x)**: grep, read 4-5 files, trace call chain (~4K tokens)
- **@medium (5x)**: rewrite auth module (~4K tokens)

**Result: ~36% cost reduction on composite tasks**, which represent ~60-70% of real coding work.

## Recommended setup

**Orchestrator**: use `Claude Sonnet 4.6` (or equivalent mid-tier) as your primary/default model.

Why: the orchestrator runs on every message, including trivial ones. A balanced model like Sonnet can read the delegation protocol and make routing decisions just as well as a heavy one like Opus. You reserve the large frontier models for when they're genuinely needed.

In your `opencode.json`, set the default model (your orchestrator):
```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "autoshare": false
}
```

Then install and configure model-router to handle the rest.

## Installation

### From npm (recommended)
```bash
# In your opencode project or globally
npm install -g opencode-model-router
```

Add it to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-model-router"]
}
```

### Local clone (for development)

Local plugins are loaded as TypeScript files placed in a plugins directory:

- `~/.config/opencode/plugins/` — global (loads in every project)
- `<project>/.opencode/plugin/` — project-scoped

Clone the repo, then drop a one-line **re-export shim** in one of those directories pointing at your working copy:

```bash
git clone https://github.com/<repo-owner>/opencode-model-router
cd opencode-model-router
npm install

# global: load your local copy in every project
cat > ~/.config/opencode/plugins/opencode-model-router.ts <<EOF
export { default } from "$PWD/src/index.ts";
EOF
```

OpenCode runs on Bun, which executes the TypeScript code and resolves the plugin's relative imports and bundled `tiers.json` from your clone. Edit, restart OpenCode, and your changes are live. No build step, no publish.

> Make sure the package is **not** also listed by name in any `opencode.json` `plugin` array, or OpenCode will load the published npm version too (you'd get the plugin twice).

## Configuration

The bundled defaults live in `tiers.json` at the plugin root. To customize models, tiers, or presets, add an **overrides file**. You should never edit the bundled file directly.

### Overrides files

Anything in an overrides file is **deep-merged** over the bundled `tiers.json` on load. You only specify the keys you want to change; everything else falls back to the defaults. These files live outside the cache dir, so they are **not** wiped when the plugin updates. They're `.jsonc`, so `//` and `/* */` comments and trailing commas are allowed.

There are two layers, applied at lowest → highest priority:

| Layer | Path | Scope |
|-------|------|-------|
| **Global** | `~/.config/opencode/opencode-model-router.overrides.jsonc` | Your personal defaults across all projects |
| **Project** | `<project>/.opencode/opencode-model-router.overrides.jsonc` | Per-project; commit it to share one routing config with your team |

The project file deep-merges over (and wins against) the global file, which in turn merges over the bundled defaults. So you can keep personal preferences globally while a committed project file unifies routing for everyone on the repo. The project file is found by searching upward from the working directory to the repo root (the nearest ancestor containing `.git`), so it is picked up even when you launch opencode from a subdirectory.

```json
{
  "presets": {
    "github-copilot": {
      "heavy": { "model": "github-copilot/claude-opus-4.8", "variant": "high" }
    }
  }
}
```

The example above changes only the `@heavy` model/variant for the `github-copilot` preset; every other tier, preset, and setting keeps its bundled value. You can also override `costRatio`, `tierCaps`, `rules`, `modes`, `enforcement`, add an entirely new preset, etc. Any top-level key from `tiers.json` can be overridden.

A fuller example overriding several keys at once (using `.jsonc`, so comments and trailing commas are fine):

```jsonc
{
  // Point one tier at a different model and give it a bigger step budget
  "presets": {
    "github-copilot": {
      "heavy": { "model": "github-copilot/claude-opus-4.8", "variant": "high", "steps": 160 },
    },
  },

  // Tighten the per-dispatch read-only caps (defaults are 8 / 5 / 3)
  "tierCaps": { "fast": 6, "medium": 4, "heavy": 2 },

  // Turn enforcement up to hard-block, and cap escalation attempts
  "enforcement": {
    "mode": "enforced",
    "escalate": { "maxTotalAttempts": 3 },
  },

  // Tweak a routing mode — objects deep-merge, so unspecified fields keep their defaults
  "modes": {
    "deep": { "description": "Deep analysis: heavy-first, long runs" },
  },

  // Arrays REPLACE (they do not append): this becomes the entire ruleset
  "rules": [
    "default preference: read-only → @fast; implementation → @medium",
    "min(cost, adequate-tier)",
  ],
}
```

Run `/router overrides` to see both file paths, whether each exists, and the precedence order.

Merge semantics: objects merge recursively; arrays and scalars are replaced wholesale (so an overridden `rules`/`whenToUse` list *replaces* the default, it does not append). If a file is missing, malformed, or produces an invalid config, the plugin logs a `[model-router]` warning and drops just that layer (keeping the others), so a typo in one file can never break startup or discard a valid file.

#### Defining a whole new preset

An overrides file can add a brand-new preset, not just tweak the bundled ones. `model` is the only required field per tier. `costRatio` and `steps` are optional. When omitted they fall back to the conventional **`1` / `5` / `20`** and **`30` / `50` / `120`** (by tier name, the same values the bundled presets use); `description`/`whenToUse` are display-only.

```jsonc
{
  "presets": {
    "openrouter": {
      "fast":   { "model": "openrouter/deepseek/deepseek-v3.2" },
      "medium": { "model": "openrouter/qwen/qwen3-coder", "costRatio": 3, "steps": 60 },
      "heavy":  { "model": "openrouter/google/gemini-3-pro", "costRatio": 9, "steps": 140 },
    },
  },
  // make it the active preset (or switch at runtime with `/preset openrouter`)
  "activePreset": "openrouter",
}
```

`@fast` omits `costRatio`/`steps`, so it gets the defaults (`1` / `30`); `@medium` and `@heavy` set their own to match their real economics. **Set `costRatio` whenever your models' relative costs differ from the default ladder**, that's the price signal the orchestrator uses to pick the cheapest adequate tier. (Routing by *task type* - `@fast`=read-only, `@medium`=implementation, `@heavy`=architecture - comes from the shared `taskPatterns`/`rules`, so it works for any preset automatically.)

The effective values, including any defaults, are shown by `/tiers`.

Restart OpenCode after adding a new preset so its tier subagents get registered. (Each model's provider must itself be configured in your `opencode.json`.)

> **`activePreset` / `activeMode` / `enforcement.mode` in an override file are _defaults_.** Runtime selections — `/preset`, `/budget`, `/router enforce` — are persisted to the state file (`~/.config/opencode/opencode-model-router.state.json`), which is applied **after** the override files and therefore wins. So the override's `activePreset` takes effect until you switch at runtime; if it ever "isn't taking", it's because a past `/preset` left a value in the state file — run `/preset <name>` again or delete that file. (The state file is machine-written, so the plugin never rewrites your hand-authored, commented override file.)

### Keeping models current

You don't have to wait on a plugin release when providers ship new models. OpenCode already resolves a live model catalog (from models.dev plus your configured/authenticated providers), and the plugin reads it directly — no external fetch, no hardcoded list:

- **`/router models [provider]`** lists the valid model ids for your configured providers, each annotated with the provider's default and any `deprecated`/`alpha`/`beta` status. Copy an id straight into an overrides file.
- **Validation**: bare `/router` checks the active preset's tier models against the catalog and reports any that are missing or deprecated, with the closest valid suggestions, so a stale id surfaces immediately instead of failing silently on every subagent dispatch. The same check is logged once per session to the plugin console at startup.

This is report-only: the plugin never changes your models for you. It tells you exactly what's available and what to change; you set it in the overrides file.

### Presets

The plugin ships with five presets (switch with `/preset <name>`):

**anthropic** (default):
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `anthropic/claude-haiku-4-5` | 1x |
| @medium | `anthropic/claude-sonnet-4-6` (max) | 5x |
| @heavy | `anthropic/claude-opus-4-8` (max) | 20x |

**openai**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `openai/gpt-5.4-mini-fast` | 1x |
| @medium | `openai/gpt-5.5-fast` (high) | 5x |
| @heavy | `openai/gpt-5.5-fast` (xhigh) | 20x |

**github-copilot**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `github-copilot/claude-haiku-4.5` | 1x |
| @medium | `github-copilot/claude-sonnet-4.6` | 5x |
| @heavy | `github-copilot/claude-opus-4.8` (high) | 20x |

**google**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `google/gemini-2.5-flash` | 1x |
| @medium | `google/gemini-2.5-pro` | 5x |
| @heavy | `google/gemini-3-pro-preview` | 20x |

**hybrid** (mixed providers):
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `anthropic/claude-haiku-4-5` | 1x |
| @medium | `openai/gpt-5.5-fast` (high) | 5x |
| @heavy | `anthropic/claude-opus-4-8` (max) | 20x |

### Routing modes

Switch with `/budget <mode>`. Mode is persisted across restarts.

| Mode | Default tier | Behavior |
|------|-------------|----------|
| `normal` | @medium | Balanced — routes by task complexity |
| `budget` | @fast | Aggressive savings — defaults cheap, escalates only when necessary |
| `quality` | @medium | Quality-first — liberal use of @medium/@heavy |
| `deep` | @heavy | Deep-analysis mode — heavy-first for architecture/debug/security with longer heavy runs |

```json
{
  "modes": {
    "budget": {
      "defaultTier": "fast",
      "description": "Aggressive cost savings",
      "overrideRules": [
        "default→@fast unless edits/complex-reasoning needed",
        "@medium ONLY: multi-file-edit/refactor/test-suite/build-fix",
        "@heavy ONLY: user-requested OR ≥2 @medium failures"
      ]
    },
    "deep": {
      "defaultTier": "heavy",
      "description": "Deep analysis mode — prioritizes thorough architecture/debug work with long heavy runs",
      "overrideRules": [
        "default→@medium for implementation and multi-file changes",
        "@heavy for architecture/debug/security/tradeoff-analysis by default",
        "allow long heavy runs before fallback; avoid premature downshift",
        "trivial(grep/read/glob)→direct,no-delegate",
        "if task is composite and phases are separable: prefer explore@fast then execute@heavy"
      ]
    }
  }
}
```

**Heavy tool-call budget:** `@heavy.steps=120` by default across presets (raised from 60) to reduce premature cutoffs on long architecture/debug tasks.

### Task taxonomy (`taskPatterns`)

Keyword routing guide injected into the system prompt. Customize to match your workflow:

```json
{
  "taskPatterns": {
    "fast": ["search/grep/read", "git-info/ls", "lookup-docs/types", "count/exists-check/rename"],
    "medium": ["impl-feature/refactor", "write-tests/bugfix(≤2)", "build-fix/create-file"],
    "heavy": ["arch-design/debug(≥3fail)", "sec-audit/perf-opt", "migrate-strategy/rca"]
  }
}
```

### Cost ratios

Set `costRatio` on each tier to reflect your real provider pricing. These are injected into the system prompt so the orchestrator makes cost-aware decisions:

```json
{
  "fast":   { "costRatio": 1  },
  "medium": { "costRatio": 5  },
  "heavy":  { "costRatio": 20 }
}
```

Adjust to actual prices. Exact values don't matter, as directional signals are enough.

### Rules

The `rules` array is injected verbatim (in compact form) into the system prompt. Default ruleset:

```json
{
  "rules": [
    "[tier:X]→delegate X",
    "plan:fast/cheap→@fast | plan:medium→@medium | plan:heavy→@heavy",
    "default preference: read-only work → @fast; implementation → @medium",
    "orchestrate=self,delegate=exec",
    "trivial (≤1 tool call, no expected follow-up) → direct, skip-delegate",
    "before dispatching @heavy: gather context first (usually via @fast); if context is already sufficient, dispatch directly",
    "if self is opus: skip-@heavy (do locally); still prefer routing broader read-only exploration to @fast",
    "min(cost,adequate-tier)"
  ]
}
```

Rules in `modes[x].overrideRules` replace this array entirely for that mode.

### Read-only call caps

Subagents carry a cap on their own read-only tool calls (grep/read/glob/ls) per dispatch. Enforcement is **two-layered**: prompt-level stop rules + runtime banners injected into tool results. Baselines (configurable via `tierCaps` — see below):

| Tier | Baseline cap | Orchestrator self-cap |
|------|-------------:|----------------------:|
| `@fast` | 8 | — |
| `@medium` | 5 | — |
| `@heavy` | 3 | — |
| Orchestrator (direct tools) | — | 2 per turn (prompt-level only) |

The orchestrator can override any subagent's cap per dispatch by including a directive in the `Task` prompt:

- `CAP:N` — tighten or loosen to N calls (e.g., `CAP:3` for a focused lookup).
- `CAP:none` — disable the numeric cap entirely (used in `quality` mode and for `@heavy` in `deep` mode).

Omitting the directive falls back to the tier baseline. Subagents may **exceed** their cap with a 1-line `reason:` in the return (target, not hard block).

#### Runtime enforcement (subagents only)

Prompt-level rules alone are unreliable: many models (including strong ones like Opus 4.7) ignore "please stop at N reads" and loop on reconnaissance for tens of minutes. To address this, the plugin tracks read-only tool calls per subagent session and **appends a banner to every read-only tool result** via the `tool.execute.after` hook. The subagent sees this banner inside the tool's own response text — not as advisory system prompt noise — which makes it very hard to ignore.

What the subagent sees inside each `grep`/`read`/`glob`/`ls` result:

```
...normal tool output...

[cap: 3/5]
```

Approaching or hitting the cap:

```
[cap: 4/5]
[⚠ CAP WARNING: 1 read-only call(s) remaining before forced return]
```

```
[cap: 5/5]
[⚠ CAP REACHED (5/5): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]
```

Redundancy (same file re-read, same `grep` pattern re-run):

```
[cap: 3/5]
[⚠ REDUNDANT: this is the same grep you ran at call #1. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]
```

The orchestrator session is **not tracked** — its self-cap of 2 direct reads per turn is prompt-only. Tool counting applies only to sessions whose `agent` matches a registered tier name.

#### Configuring caps (`tierCaps`)

```json
{
  "tierCaps": {
    "fast": 8,
    "medium": 5,
    "heavy": 3
  }
}
```

Values are positive integers. Missing tier → falls back to the hardcoded default (same numbers). Change these to tighten/loosen the baseline without editing any prompt.

#### Return protocol

Independent of the numeric cap, every subagent runs a redundancy check before each new tool call. On stop (cap reached, redundancy detected, scope satisfied, or runtime banner), the subagent returns with exactly one of:

| Return prefix | Meaning |
|--------------|---------|
| `DONE: …` | Dispatch request fully satisfied; synthesize into final answer. |
| `NEED MORE: …` (or `NEED CONTEXT:` for `@medium`, `SCOPE GROWTH:` for `@heavy`) | Subagent needs another targeted round; orchestrator decides what to dispatch. |
| `ESCALATE: …` | Scope grew beyond the subagent's role; orchestrator re-routes. |

This keeps subagents from burning tokens on repeated lookups when they already have enough context. `CAP:none` lifts the numeric cap but **does not** disable the redundancy check — the runtime still injects `[⚠ REDUNDANT]` banners regardless of cap setting.

**Mode interactions:**

| Mode | Dispatch directive | Orchestrator self-cap |
|------|-------------------|-----------------------|
| `normal` | baselines (omit directive) | ≤2 direct reads |
| `budget` | `CAP:5` @fast, `CAP:2` @medium, `CAP:2` @heavy | ≤1 direct read |
| `quality` | `CAP:none` on all dispatches | ≤2 direct reads |
| `deep` | `CAP:none` on `@heavy` only; baselines elsewhere | ≤2 direct reads |

### Tier prompts (`tierPrompts`)

Each tier (`@fast`, `@medium`, `@heavy`) has a system prompt that describes its role, scope, call cap, and return protocol. To avoid duplicating the same string across every preset, the router uses a **global default with per-tier override**:

```json
{
  "tierPrompts": {
    "fast":   "You are @fast — ... (full global prompt)",
    "medium": "You are @medium — ...",
    "heavy":  "You are @heavy — ..."
  },
  "presets": {
    "anthropic": {
      "fast":   { "model": "anthropic/claude-haiku-4-5", ... },
      "medium": { "model": "anthropic/claude-sonnet-4-6", ... },
      "heavy":  { "model": "anthropic/claude-opus-4-8", ... }
    }
  }
}
```

**Resolution order per tier:**

1. If the preset's tier defines `"prompt": "..."` inline → use it (per-tier override).
2. Otherwise → fall back to `tierPrompts[<tierName>]`.
3. If neither is set → the tier registers without a system prompt.

**When to customize:** if a specific provider/model in a preset needs different instructions (e.g. Gemini-specific tool format, tighter/looser caps for a weaker local model), add `"prompt": "..."` on that tier only. All other presets keep using the global.

```json
{
  "presets": {
    "google": {
      "fast": {
        "model": "google/gemini-2.5-flash",
        "prompt": "You are @fast (Gemini-tuned variant) — ...",
        ...
      }
    }
  }
}
```

### Claude-model adversarial prefixes (automatic)

Anthropic models (served directly via `anthropic/*` or routed through other providers as `*/claude-*`) ship with a large cached system prompt that primes them toward broad exploratory Read/Grep/Glob behavior. When such a prompt sits in front of your router instructions, primacy bias and prompt caching weaken the router's authority — subagents ignore caps, orchestrators run read-only work themselves instead of dispatching.

To counteract this, the router **automatically prepends an adversarial opener** to:

- The tier prompt for any tier whose `model` matches a Claude identifier
- The orchestrator delegation protocol when the session model is a Claude identifier

Detection is by model string, not preset. A `hybrid` preset that mixes providers (e.g. `openai/*` for @fast, `anthropic/*` for @medium and @heavy) gets the override only on its Claude-backed tiers.

**Tone assignment:**

| Target | Tone | Opener label |
|--------|------|--------------|
| `@fast` (Claude) | Scoping — conversational | `SCOPE NOTE` |
| `@medium` (Claude) | Scoping — conversational | `SCOPE NOTE` |
| `@heavy` (Claude) | Override — firm | `AUTHORITY OVERRIDE` |
| Orchestrator (Claude) | Override — firm | `AUTHORITY OVERRIDE` |

`@heavy` and the orchestrator use the firmer tone because that's where reconnaissance loops were worst in observed sessions. `@fast` and `@medium` use a softer scoping note to avoid over-correcting legitimate multi-read tasks.

**Detection rules:**

- `anthropic/<anything>` → Claude
- `<provider>/claude-<anything>` (e.g. `github-copilot/claude-sonnet-4-6`) → Claude
- `<provider>/<namespace>.claude-<anything>` (e.g. `bedrock/us.anthropic.claude-3-5-sonnet-...`) → Claude
- Everything else → untouched

No configuration is needed — the prefixes are always applied for Claude-backed tiers. If you want to disable them, override the tier's `prompt` field (per-tier overrides replace the whole prompt, including the prefix).

### Anti-narration guardrail (Claude models, opt-in)

Some Claude models (historically, thinking-enabled Sonnet with the `max` variant) can produce progress narration instead of actual work, phrasings like *"Still writing the X function..."*, *"Now I'll implement Y..."*, *"Let me add Z..."*, without the X/Y/Z ever appearing.

This guardrail is **off by default**. It costs ~162 tokens per Claude dispatch (the prompt clause) and its detector false-positives on normal productive phrasing like "Now I'll add the test" when the test does follow, so it is opt-in. Enable it only if you actually observe narration-without-production on your models:

```jsonc
{ "antiNarration": true }
```

When enabled, it works on two layers:

**1. Prompt-level clause (prevention).** A dedicated `ANTI-NARRATION` block is appended to every Claude-backed tier prompt and to the Claude-backed orchestrator delegation protocol. It names the forbidden phrasings explicitly and requires concrete output to follow any such phrase. A carve-out preserves legitimate explanation/plan requests from the user.

**2. Post-hoc detector (telemetry).** An `experimental.text.complete` hook scans completed text for narration regex patterns. On match, it:

- Logs a warning to the plugin console:
  ```
  [model-router] narration detected (session abc123): "Still writing the auth", "Now I'll add the tests"
  ```
- Appends a visible banner to the text as it's rendered to the user:
  ```
  [⚠ narration detected: "Still writing the auth", "Now I'll add the tests"]
  ```

The detector is not blocking — plugin hooks cannot modify tokens mid-stream. It signals post-hoc so you can spot the pattern in the UI and in logs, and judge whether the prompt-level clause is holding up.

Detected patterns (conservative set to minimize false positives):

- `Still (writing|implementing|working on|...) the X`
- `Now (I'll)? (write|implement|add|...) the X`
- `Let me (write|implement|add|...) (the )? X`
- `I'll (now)? (write|implement|...) the X`
- `Going to (write|implement|...) the X`
- `Continuing (with|by ...ing) (the )? X`

When `antiNarration` is enabled, the detector runs for all models (not only Claude), while the prompt-level clause is Claude-only, so non-Claude models get detector-only. With the default (`antiNarration` off), neither layer runs.

### Tier fields reference

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Full model ID (`provider/model-name`) |
| `variant` | string | Optional variant (`"max"`, `"xhigh"`, `"thinking"`) |
| `costRatio` | number | Relative cost (1 = cheapest). Shown in prompt. |
| `thinking` | object | Anthropic thinking: `{ "budgetTokens": 10000 }` |
| `reasoning` | object | OpenAI reasoning: `{ "effort": "high", "summary": "detailed" }` |
| `description` | string | Shown in `/tiers` output |
| `steps` | number | Max agent turns |
| `prompt` | string | Optional per-tier system prompt override. Falls back to top-level `tierPrompts[<tierName>]` when omitted. |
| `whenToUse` | string[] | Use cases (shown in `/tiers`, not in system prompt) |

### Fallback

Defines provider fallback order when a delegated task fails:

```json
{
  "fallback": {
    "global": {
      "anthropic": ["openai", "google", "github-copilot"],
      "openai": ["anthropic", "google", "github-copilot"]
    }
  }
}
```

## Delegation enforcement (advisory by default)

The read-only cap banners described above are advisory: a well-behaved subagent will respect them, but nothing prevents a model from making one more read after the `[⚠ CAP REACHED]` banner. The **enforcement layer** turns delegation into a produce → verify → accept/escalate loop with independent acceptance and quality escalation. As of v1.3.0 it runs in **`advisory` mode by default**: every non-trivial delegation is verified and any miss surfaces a forcing-note, but nothing is ever hard-blocked (the orchestrator system prompt grows by ~200 tokens for the DoD/acceptance section, and subagents may receive non-blocking guard banners). Set `"mode": "off"` — or run `/router enforce off` — to restore byte-for-byte-unchanged routing with zero added prompt tokens and zero new latency. Hard-blocks only activate in `"mode": "enforced"`.

### The three enforcement layers

- **Layer 1 — hard-block guard.** A `tool.execute.before` hook throws before a disallowed tool call executes, stopping budget overruns, redundant reads, and throwaway-script sidesteps in subagent sessions.
- **Layer 2 — independent acceptance gate.** Every non-trivial delegation carries a Definition-of-Done (DoD) that is checked — deterministically or by an independent grader at ≥ the producer's tier — before the result is trusted. The producer never grades its own output.
- **Layer 3 — quality-escalation ladder.** On a failed check: retry once, then escalate fast → medium → heavy, bounded by attempt and cost ceilings. The loop ends in an honest `status: unmet` rather than a fabricated pass.

### Two operating modes

- **Mode A — on-the-fly.** The orchestrator delegates through the native `Task()` tool — observed and verified automatically by the enforcement pipeline, and rendered inline in the TUI. (An optional, independently-verified `delegate` tool can be enabled via `experimental.verifiedDelegateTool` in `tiers.json` or `MODEL_ROUTER_VERIFIED_DELEGATE=1`; it is hidden by default so delegation stays visible.)
- **Mode B — plan-annotated.** `/annotate-plan` emits `[tier:X]` plus an `[acceptance]` block per task; the enforcement loop is wired up at execution time based on those annotations.

### Tuning enforcement

Advisory is the default. To change the level:

1. Add or edit the `enforcement` block in `tiers.json` — `"mode": "off"`, `"advisory"`, or `"enforced"` (see `docs/CONFIG_REFERENCE.md`).
2. Set `MODEL_ROUTER_ENFORCE=1` to force `enforced` for a session, or `MODEL_ROUTER_ENFORCE=0` to force `off`.
3. Run `/router enforce <off|advisory|enforced>` from the chat to toggle at runtime.

**Modes:** `off` — no-op, byte-for-byte-unchanged routing (must now be set explicitly, since `advisory` is the default); `advisory` (default) — evaluates and surfaces guidance, never blocks; `enforced` — hard-blocks active, full produce → verify → accept/escalate pipeline.

> Enforcement applies to subagent/delegate sessions only. The orchestrator session is never hard-blocked.

### Deep-dive documentation

- `docs/ENFORCEMENT.md` — architecture, hook wiring, session lifecycle
- `docs/VERIFICATION.md` — DoD schema, deterministic checks, grader dispatch
- `docs/ESCALATION.md` — escalation ladder configuration and cost ceilings
- `docs/CONFIG_REFERENCE.md` — full `enforcement` block schema
- `docs/ENFORCEMENT_PRESETS.md` — ready-to-paste enforcement presets

> These files are not included in the npm tarball. This section is the self-contained summary; the docs are available in the repository for contributors and advanced users.

## Commands

| Command | Description |
|---------|-------------|
| `/tiers` | Show active tier configuration, models, and rules |
| `/preset` | List available presets |
| `/preset <name>` | Switch preset (e.g., `/preset openai`) |
| `/budget` | Show available modes and which is active |
| `/budget <mode>` | Switch routing mode (`normal`, `budget`, `quality`, `deep`) |
| `/annotate-plan [path]` | Annotate a plan file with `[tier:X]` tags for each step |
| `/router overrides` | Show the global + project override file paths and merge precedence |
| `/router models [provider]` | List valid model ids from your configured providers (with defaults + deprecated flags) |
| `/router enforce <off\|advisory\|enforced>` | Set delegation-enforcement mode (persisted) |
| `/bypass [on\|off]` | Toggle the router off/on for the session |

## Plan annotation

For complex tasks, you can write a plan file and annotate each step with the correct tier. The `/annotate-plan` command reads the plan and adds `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]` tags to each step based on the task taxonomy.

The orchestrator then reads these tags and delegates accordingly — removing ambiguity from routing decisions on long, multi-step tasks.

Example plan (before annotation):
```markdown
1. Find all API endpoints in the codebase
2. Add rate limiting middleware to each endpoint
3. Write integration tests for rate limiting
4. Design a token bucket algorithm for advanced rate limiting
```

After `/annotate-plan`:
```markdown
1. [tier:fast] Find all API endpoints in the codebase
2. [tier:medium] Add rate limiting middleware to each endpoint
3. [tier:medium] Write integration tests for rate limiting
4. [tier:heavy] Design a token bucket algorithm for advanced rate limiting
```

## Token overhead

The delegation protocol is injected into the orchestrator's system prompt on every message. Measured against the currently shipped protocol (approximate tokens):

| Orchestrator + mode | ~tokens/msg |
|---|---|
| non-Claude orchestrator, `enforcement: off` | ~1,400 |
| non-Claude orchestrator, advisory (default) | ~1,600 |
| Claude orchestrator, `enforcement: off` | ~1,750 |
| Claude orchestrator, advisory (default) | ~1,950 |

Two things drive the size: a Claude orchestrator gets an extra adversarial / anti-narration prefix (~350 tokens), and advisory or enforced mode adds the acceptance-contract section (~200 tokens). To minimize overhead, run a non-Claude orchestrator and/or set `enforcement.mode: "off"`.

The protocol was much smaller in early versions (~210 tokens through v1.1). It grew when the enforcement layer and Claude-hardening prefixes were added, and a good chunk of the current size is redundancy (the routing rules and caps are each stated more than once).

| Version | Approx tokens | Notes |
|---------|--------|----------|
| v1.0.7 | ~208 | basic tier routing |
| v1.1.x | ~210 | all features, compact format |
| v1.2 to v1.4 | ~1,400 to 1,950 | added enforcement layer + Claude-hardening prefixes |

## Requirements

- [OpenCode](https://opencode.ai) v1.0 or later
- Node.js 18+
- Provider API keys configured in OpenCode

## License

GPL-3.0
