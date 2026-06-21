# Custom Slash Command Patterns in OpenCode Plugins

Worked example: the `opencode-model-router` plugin.

**Source:** `src/index.ts` (factory + hooks) and `src/commands/output.ts` (pure response renderers).

> Citations are by **file + symbol**, not line number (line numbers drift). See [LINE_REFERENCES.md](./LINE_REFERENCES.md) for the module map.

---

## 1. Command registration via the `config` hook

Register commands by adding to `opencodeConfig.command` inside the `config` hook (`src/index.ts`):

```typescript
config: async (opencodeConfig: any) => {
  // ... agent registration ...

  opencodeConfig.command ??= {};

  opencodeConfig.command["tiers"] = {
    template: "",
    description: "Show model delegation tiers and rules",
  };
  opencodeConfig.command["preset"] = {
    template: "$ARGUMENTS",
    description: "Show or switch model presets (e.g., /preset openai)",
  };
  opencodeConfig.command["budget"] = {
    template: "$ARGUMENTS",
    description: "Show or switch routing mode (e.g., /budget budget)",
  };
  opencodeConfig.command["bypass"] = {
    template: "$ARGUMENTS",
    description: "Toggle model-router bypass for this session",
  };
  opencodeConfig.command["router"] = {
    template: "$ARGUMENTS",
    description: "Model-router controls (/router enforce|overrides|models)",
  };
  opencodeConfig.command["annotate-plan"] = {
    template: ["Annotate the plan with tier directives...", /* ... */].join("\n"),
    description: "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
  };
}
```

### Command config object

| Field | Type | Purpose |
|-------|------|---------|
| `template` | `string` \| `string[]` | `""` (no args), `"$ARGUMENTS"` (raw args), or a multi-line template the model executes (e.g. `/annotate-plan`) |
| `description` | `string` | Help text shown to the user |

---

## 2. Command handler — the `command.execute.before` hook

model-router dispatches with a `switch` plus `reload()`/`push()` helpers, keeping each case to one line:

```typescript
"command.execute.before": async (input: any, output: any) => {
  const args = (input.arguments ?? "").trim();
  const reload = () => { try { cfg = loadConfig(); } catch {} };
  const push = (text: string) =>
    output.parts.push({ type: "text" as const, text });

  switch (input.command) {
    case "tiers":  reload(); push(buildTiersOutput(cfg)); break;
    case "preset": reload(); push(handlePreset(args)); break;
    case "budget": reload(); push(handleBudget(args)); break;
    case "bypass":           push(handleBypass(args)); break;
    case "router": reload(); push(await handleRouterCommand(args)); break;
  }
}
```

| Property | Type | Content |
|----------|------|---------|
| `input.command` | `string` | Command name (no `/`) |
| `input.arguments` | `string \| null` | Raw argument string |
| `output.parts` | array | Push `{ type: "text" as const, text }` to respond |

**Separation of concerns:** the handler *decides and mutates* (parse args, call the `save*` writers); the *rendering* is delegated to pure functions in `src/commands/output.ts`. Stateful commands use small closures — `handlePreset`, `handleBudget`, `handleBypass`, `handleRouterCommand` — defined in the factory.

---

## 3. Argument handling

Example — `handleBudget` (`src/index.ts`) + the pure renderers (`src/commands/output.ts`):

```typescript
const handleBudget = (args: string): string => {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) return buildNoModes();
  const requested = args.trim().toLowerCase();   // normalize
  if (!requested) return buildBudgetList(cfg);    // no args → show state
  const mode = modes[requested];
  if (!mode) return buildUnknownMode(modes, requested); // validate
  saveActiveMode(requested);                      // mutate + persist
  return buildBudgetSwitched(mode, requested);    // confirm
};
```

Checklist: normalize (`trim().toLowerCase()`), handle the empty-args case (show help/state), validate against allowed values, return a helpful error otherwise, and confirm on success.

---

## 4. Hook lifecycle and config caching

Config is loaded once and cached; writers mark it dirty (`src/router/config.ts`):

```typescript
let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

export function invalidateConfigCache(): void { _configDirty = true; }

export function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) return;
  cfg.activePreset = resolved;
  writeState({ activePreset: resolved }); // ~/.config/opencode/opencode-model-router.state.json
  invalidateConfigCache();                // force reload on next access
}
```

The hooks that need fresh config call `loadConfig()` (returns the cache unless invalidated): `command.execute.before` (via `reload()`), `chat.message`, and `experimental.chat.system.transform`.

---

## 5. System-prompt injection

```typescript
"experimental.chat.system.transform": async (_input: any, output: any) => {
  if (bypassed) return;
  try { cfg = loadConfig(); } catch { /* keep last known config */ }

  // Skip injection for subagent sessions (they execute, they don't orchestrate).
  const sessionID = _input?.sessionID;
  if (sessionID && sessionStore.isSubagent(sessionID)) return;

  const orchestratorModel = /* providerID/modelID from _input.model */;
  const enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
  output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
}
```

`assembleSystemPrompt` (`src/router/protocol.ts`) returns the compressed delegation protocol (plus Claude adversarial prefixes / anti-narration and, when enforcement is on, the DoD section). What the orchestrator sees, e.g. for the anthropic preset:

```
## Model Delegation Protocol
Preset: anthropic. Tiers: @fast=claude-haiku-4-5(1x) @medium=claude-sonnet-4-6/max(5x) @heavy=claude-opus-4-8/max(20x). mode:normal
R: @fast→search/grep/read/... @medium→impl-feature/refactor/... @heavy→arch-design/debug(≥3fail)/...
Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable.
Err→retry-alt-tier→fail→direct. Chain: anthropic→openai→google→github-copilot
Delegate with Task(subagent_type="fast|medium|heavy", prompt="...").
```

---

## 6. User feedback

Responses are pure markdown builders in `src/commands/output.ts` — e.g. `buildPresetSwitched` and `buildBudgetSwitched`:

```typescript
export function buildPresetSwitched(cfg: RouterConfig, name: string): string {
  const models = Object.entries(cfg.presets[name]!)
    .map(([tier, t]) => `  @${tier} -> ${t.model}`).join("\n");
  return [
    `Preset switched to **${name}**.`, "", models, "",
    "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
    "Restart OpenCode for subagent model registration to take effect.",
    "System prompt delegation rules update immediately.",
  ].join("\n");
}
```

Patterns: markdown (`**bold**`, `` `code` ``, `-` lists); build multi-line as an array joined with `"\n"`; state clearly what changed; disclose side effects (persistence/restart); always show a usage hint. The plugin does **not** use `tui.showToast()` — all feedback is returned as text parts.

---

## 7. Configuration files

`tiers.json` holds the bundled defaults; user overrides deep-merge over it (see the README **Configuration** section and [CONFIG_REFERENCE.md](./CONFIG_REFERENCE.md)):

```json
{
  "activePreset": "anthropic",
  "defaultTier": "medium",
  "presets": {
    "anthropic": { "fast": { "model": "anthropic/claude-haiku-4-5", "costRatio": 1, "description": "...", "whenToUse": [] }, "medium": {}, "heavy": {} },
    "openai": {}, "github-copilot": {}, "google": {}, "hybrid": {}
  },
  "rules": [],
  "modes": { "normal": {}, "budget": {}, "quality": {}, "deep": {} },
  "enforcement": {}
}
```

- **Bundled defaults:** the cached `tiers.json`.
- **Global overrides:** `~/.config/opencode/opencode-model-router.overrides.jsonc`.
- **Project overrides:** `<repo>/.opencode/opencode-model-router.overrides.jsonc` (found by upward search; deep-merged over global).
- **Persisted UI state:** `~/.config/opencode/opencode-model-router.state.json` (active preset/mode/enforcement only).

---

## 8. Complete flow — the `/preset` command

```typescript
// 1. REGISTER (config hook)
opencodeConfig.command["preset"] = {
  template: "$ARGUMENTS",
  description: "Show or switch model presets (e.g., /preset openai)",
};

// 2. DISPATCH (command.execute.before)
case "preset": reload(); push(handlePreset(args)); break;

// 3. DECIDE + MUTATE (handler closure in index.ts)
const handlePreset = (args: string): string => {
  const requested = args.trim();
  if (!requested) return buildPresetList(cfg);
  const resolved = resolvePresetName(cfg, requested);
  if (!resolved) return buildUnknownPreset(cfg, requested);
  saveActivePreset(resolved);     // persist (config.ts)
  cfg.activePreset = resolved;
  return buildPresetSwitched(cfg, resolved);
};

// 4. RENDER (pure, src/commands/output.ts) — buildPresetList / buildPresetSwitched / buildUnknownPreset
// 5. PERSIST (src/router/config.ts) — saveActivePreset → writeState + invalidateConfigCache
```

---

## Summary reference

| Aspect | Where | Key detail |
|--------|-------|------------|
| Command registration | `config` hook (`src/index.ts`) | Add to `opencodeConfig.command` |
| Command dispatch | `command.execute.before` (`src/index.ts`) | `switch (input.command)`; `reload()`/`push()` helpers |
| Stateful handlers | `handlePreset`/`handleBudget`/`handleBypass`/`handleRouterCommand` (factory closures) | Decide + persist, then render |
| Response rendering | `src/commands/output.ts` | Pure: data in → markdown out |
| State persistence | `save*` in `src/router/config.ts` | `writeState()` + `invalidateConfigCache()` |
| Config caching | `loadConfig()` / `invalidateConfigCache()` | Cached; reloaded after invalidation |
| System-prompt injection | `experimental.chat.system.transform` | `output.system.push(assembleSystemPrompt(...))` |
| Output format | `output.parts.push()` | `{ type: "text" as const, text }`; no `tui.showToast()` |
