# Command Execution Flow Diagrams

> Diagrams reference **symbols/files**, not line numbers (they drift). See [LINE_REFERENCES.md](./LINE_REFERENCES.md) for the module map.

## 1. Command Registration & Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Plugin Initialization (factory in src/index.ts)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ config hook (src/index.ts)                                      │
│ • opencodeConfig.agent[]   = register tier agents               │
│ • opencodeConfig.command[] = register slash commands:           │
│   tiers, preset, budget, bypass, router, annotate-plan          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
          ┌───────────────────────────────────────┐
          │ User types: /preset openai             │
          └───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ command.execute.before hook (src/index.ts)                      │
│   input.command = "preset"; input.arguments = "openai"          │
│                                                                 │
│   switch (input.command) {                                      │
│     case "preset": reload(); push(handlePreset("openai"));      │
│   }                                                             │
│   reload() = loadConfig() (cached unless dirty)                 │
│   push()   = output.parts.push({ type:"text", text })          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ handlePreset("openai")  (closure in src/index.ts)               │
│                                                                 │
│ 1. resolvePresetName(cfg, "openai") → "openai"                  │
│ 2. saveActivePreset("openai")   (src/router/config.ts)          │
│    └─ writeState({activePreset:"openai"}) + invalidateConfigCache()│
│ 3. cfg.activePreset = "openai"                                  │
│ 4. return buildPresetSwitched(cfg, "openai")                    │
│         (pure renderer in src/commands/output.ts)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ output.parts.push({ type:"text", text:"Preset switched ..." })  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
          ┌───────────────────────────────────────┐
          │ Response shown to user                 │
          └───────────────────────────────────────┘
```

Other commands follow the same shape: `tiers` → `buildTiersOutput`; `budget` → `handleBudget`; `bypass` → `handleBypass`; `router` → `handleRouterCommand` (async: `enforce`/`overrides`/`models`/status).

---

## 2. State Persistence & Cache Invalidation

```
┌─────────────────────────────────────────────────────────────────┐
│ Initial State:  _cachedConfig = null;  _configDirty = true      │
└─────────────────────────────────────────────────────────────────┘
                              │
                    User runs /preset openai
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ loadConfig()  (src/router/config.ts)                            │
│  if (_cachedConfig && !_configDirty) return cache               │
│  else build effective config (lowest→highest priority):         │
│    bundled tiers.json                                           │
│    → global  ~/.config/opencode/opencode-model-router.overrides.jsonc     │
│    → project <repo>/.opencode/opencode-model-router.overrides.jsonc       │
│    → persisted state (active preset/mode/enforcement)           │
│  cache it; _configDirty = false                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ saveActivePreset("openai")  (src/router/config.ts)              │
│  Step 1: cfg.activePreset = "openai"                            │
│  Step 2: writeState({activePreset:"openai"})                    │
│          └─ ~/.config/opencode/opencode-model-router.state.json │
│  Step 3: invalidateConfigCache()  → _configDirty = true         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Next message → experimental.chat.system.transform calls         │
│ loadConfig(); sees _configDirty=true; rebuilds; picks up the    │
│ new activePreset and refreshes the injected delegation protocol │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Argument Parsing Pattern

```
User: /preset openai
  → input.command = "preset"; input.arguments = "openai"
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ handlePreset("openai")                                          │
│   const requested = "openai".trim()        // "openai"          │
│                                                                 │
│   if (!requested)            → buildPresetList(cfg)             │
│   else resolvePresetName(cfg, requested)                        │
│        ├─ not found          → buildUnknownPreset(cfg, requested)│
│        └─ found ("openai")   → saveActivePreset("openai")        │
│                               cfg.activePreset = "openai"        │
│                               → buildPresetSwitched(cfg,"openai")│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Response sent to user
```

The decide/mutate logic lives in the handler closure; the three return paths are pure renderers in `src/commands/output.ts`.

---

## 4. System Prompt Injection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User sends a message                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ experimental.chat.system.transform (src/index.ts)              │
│   if (bypassed) return;                                         │
│   cfg = loadConfig();            // reload if dirty             │
│   if (subagent session) return;  // only inject for orchestrator│
│   enfOn = resolveEnforcementMode(...).mode !== "off"            │
│   output.system.push(                                           │
│     assembleSystemPrompt(cfg, orchestratorModel, enfOn))        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ assembleSystemPrompt(...)  (src/router/protocol.ts)             │
│  → delegation protocol (+ Claude adversarial/anti-narration     │
│    prefixes; + DoD section when enforcement is on):             │
│                                                                 │
│ ## Model Delegation Protocol                                    │
│ Preset: anthropic. Tiers: @fast=claude-haiku-4-5(1x)           │
│   @medium=claude-sonnet-4-6/max(5x) @heavy=claude-opus-4-8/max  │
│ R: @fast→search/grep/read... @medium→impl... @heavy→arch...     │
│ Multi-phase: explore(@fast)→execute(@medium) when separable.    │
│ Err→retry-alt-tier→fail→direct. Chain:                          │
│   anthropic→openai→google→github-copilot                        │
│ Delegate with Task(subagent_type="fast|medium|heavy", ...)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Model receives core instructions + injected protocol and now    │
│ knows the tiers, their models, the routing rules, and how to    │
│ delegate via Task().                                            │
└─────────────────────────────────────────────────────────────────┘
```

Subagent sessions are skipped (detected in `chat.message`) so a tier executing a task is not handed orchestration instructions.

---

## 5. Complete Minimal Command Example

```
┌────────────────────────────────────────────────────────────────┐
│ Plugin Definition                                              │
└────────────────────────────────────────────────────────────────┘

const MyPlugin: Plugin = async (_ctx: PluginInput) => {
  let state = { count: 0 };

  return {
    config: async (opencodeConfig: any) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command["counter"] = {
        template: "$ARGUMENTS",  // Accept args: /counter increment
        description: "Increment or show counter",
      };
    },

    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "counter") {
        const args = (input.arguments ?? "").trim();

        if (!args) {
          output.parts.push({ type: "text" as const, text: `Counter: ${state.count}` });
          return;
        }
        if (args === "increment") {
          state.count++;
          output.parts.push({ type: "text" as const, text: `Counter incremented to: **${state.count}**` });
          return;
        }
        output.parts.push({ type: "text" as const, text: `Unknown arg: "${args}". Try: /counter increment` });
      }
    },
  };
};

// Usage:
// /counter            → "Counter: 0"
// /counter increment  → "Counter incremented to: **1**"
// /counter unknown    → "Unknown arg: \"unknown\". Try: /counter increment"
```

---

## 6. Output Type System

```
output.parts is an array of message parts:

output.parts = [
  { type: "text" as const, text: "This is the response text" },
  // other types may exist in the host; model-router uses "text" only
]

All responses are built as Markdown strings:
• **bold** for emphasis   • `code` for monospace
• # Headings              • - Bullet lists
• Line breaks via empty strings joined with "\n"
```

---

## 7. File Organization

```
opencode-model-router/
│
├── tiers.json                       # bundled defaults
│   ├── activePreset / defaultTier
│   ├── presets: anthropic, openai, github-copilot, google, hybrid
│   ├── modes:   normal, budget, quality, deep
│   ├── rules / taskPatterns / tierCaps / tierPrompts
│   └── enforcement {...}
│
├── src/
│   ├── index.ts                     # plugin factory: hooks + handler closures
│   ├── router/
│   │   ├── config.ts                # load/validate/merge config + state + save*
│   │   ├── protocol.ts              # assembleSystemPrompt + tier prompts
│   │   ├── sessions.ts              # per-session tier/cap tracking
│   │   ├── enforcement.ts           # enforcement-mode resolver
│   │   └── catalog.ts               # model-catalog normalize/validate
│   ├── commands/output.ts           # pure slash-command renderers
│   ├── guard/*                      # Layer 1 hard-block guard
│   ├── verify/*                     # Layer 2 acceptance gate (+ wiring.ts)
│   └── escalate/ladder.ts           # Layer 3 escalation ladder
│
└── ~/.config/opencode/
    ├── opencode-model-router.state.json   # active preset/mode/enforcement
    └── opencode-model-router.overrides.jsonc        # optional global overrides (deep-merged)
        # project overrides: <repo>/.opencode/opencode-model-router.overrides.jsonc
```

---

## 8. Decision Tree for Command Arguments

```
Handler receives: input.arguments = "user input" or null
                              │
                              ▼
              args = (input.arguments ?? "").trim()  // [.toLowerCase() if case-insensitive]
                              │
                              ▼
                    ┌──────────────────────────┐
                    │ Is args empty? if (!args)│
                    └──────────────────────────┘
                        │           │
                      YES           NO
                        │           │
                        ▼           ▼
            ┌─────────────────┐ ┌────────────────┐
            │ Show help /     │ │ Is it a valid  │
            │ current state   │ │ value?         │
            │ (list builder)  │ │                │
            └─────────────────┘ │ Yes      No    │
                                └─┬────────┬──────┘
                                  ▼        ▼
                        ┌────────────┐ ┌────────────┐
                        │ save* +    │ │ Unknown-   │
                        │ persist +  │ │ value      │
                        │ confirm    │ │ renderer   │
                        │ renderer   │ │ (+ valid   │
                        │            │ │  options)  │
                        └────────────┘ └────────────┘
```
