# OpenCode Custom Slash Command Reference Index

## Overview

How custom slash commands are registered and handled in OpenCode plugins, using the `opencode-model-router` plugin as the worked example.

**Source:** `src/index.ts` (the plugin factory) plus `src/commands/output.ts` (the pure response renderers).

> Citations below are by **file + symbol name**, not line numbers — line numbers drift on every edit. See [LINE_REFERENCES.md](./LINE_REFERENCES.md) for the canonical module map.

---

## Companion docs

### COMMAND_PATTERNS.md — ⭐ start here
Complete patterns with explanations: command registration via the `config` hook, the handler signature, argument handling, state persistence + cache invalidation, system-prompt injection, response formatting, and a worked walkthrough.

### scripts/QUICK_REFERENCE.ts — 🚀 copy-paste templates
Minimal code templates for registration, handlers, argument parsing, state persistence, and prompt injection. (Lives under `scripts/`, not `docs/`.)

### LINE_REFERENCES.md — 🗺️ module map
A symbol-based index of every source module and the hooks the factory registers. No line numbers — reference by file + symbol.

### FLOW_DIAGRAMS.md — 📊 visual flow
ASCII diagrams of command registration/execution, state persistence + cache invalidation, argument parsing, and system-prompt injection.

---

## Key code patterns

### Pattern 1 — command registration (in the `config` hook)
```typescript
opencodeConfig.command ??= {};
opencodeConfig.command["mycommand"] = {
  template: "$ARGUMENTS",  // or "" for no args
  description: "Description shown to the user",
};
```

### Pattern 2 — command handler (in `command.execute.before`)
```typescript
"command.execute.before": async (input: any, output: any) => {
  const push = (text: string) =>
    output.parts.push({ type: "text" as const, text });
  switch (input.command) {
    case "mycommand":
      push(buildMyOutput(/* ... */));
      break;
  }
}
```
model-router uses a `switch` plus `reload()`/`push()` helpers; stateful commands delegate to small handler closures (`handlePreset`, `handleBudget`, `handleRouterCommand`, `handleBypass`).

### Pattern 3 — state persistence (in `src/router/config.ts`)
```typescript
export function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) return;
  cfg.activePreset = resolved;
  writeState({ activePreset: resolved }); // ~/.config/opencode/opencode-model-router.state.json
  invalidateConfigCache();                // force reload on next access
}
```
The `save*` writers live in `config.ts` (their natural home); the command handlers call them.

### Pattern 4 — system-prompt injection (runs every message)
```typescript
"experimental.chat.system.transform": async (_input, output) => {
  cfg = loadConfig();
  output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
}
```

### Pattern 5 — user feedback (pure renderers)
Response text is built by pure functions in `src/commands/output.ts` (config/data in → markdown out), e.g. `buildTiersOutput`, `buildPresetList`/`buildPresetSwitched`, `buildModelsOutput`. The handler decides + persists, then calls a renderer.

---

## File dependencies

```
opencode-model-router/
├── src/index.ts                 — plugin factory (default export); hook orchestration
│   ├── src/router/config.ts     — config load/validate/merge + state + save* writers
│   ├── src/router/protocol.ts   — delegation protocol + tier prompt strings
│   ├── src/router/sessions.ts   — per-session tier/cap tracking
│   ├── src/router/enforcement.ts— enforcement-mode resolver
│   ├── src/router/catalog.ts    — model-catalog normalize/validate (/router models)
│   ├── src/commands/output.ts   — pure slash-command renderers
│   ├── src/guard/*              — Layer 1 hard-block guard
│   ├── src/verify/*             — Layer 2 acceptance gate (+ wiring.ts seams)
│   └── src/escalate/ladder.ts   — Layer 3 escalation ladder
├── tiers.json                   — bundled defaults (presets/modes/rules/enforcement)
│   ├── presets: anthropic, openai, github-copilot, google, hybrid
│   └── modes:   normal, budget, quality, deep
└── ~/.config/opencode/
    ├── opencode-model-router.state.json        — persisted preset/mode/enforcement
    └── opencode-model-router.overrides.jsonc             — optional global overrides (deep-merged)
        (+ <repo>/.opencode/opencode-model-router.overrides.jsonc for project overrides)
```

---

## Exported commands

The plugin registers six commands (in the `config` hook). Output builders are in `src/commands/output.ts`; stateful commands route through a handler closure in `index.ts`.

| Command | Template | Handler | Output builder(s) |
|---------|----------|---------|-------------------|
| `/tiers` | `""` | inline | `buildTiersOutput()` |
| `/preset [name]` | `$ARGUMENTS` | `handlePreset()` | `buildPresetList()` / `buildPresetSwitched()` / `buildUnknownPreset()` |
| `/budget [mode]` | `$ARGUMENTS` | `handleBudget()` | `buildBudgetList()` / `buildBudgetSwitched()` / `buildUnknownMode()` / `buildNoModes()` |
| `/bypass [on\|off]` | `$ARGUMENTS` | `handleBypass()` | `buildBypassMessage()` |
| `/router [sub]` | `$ARGUMENTS` | `handleRouterCommand()` | `buildEnforceSet/Status()`, `buildOverridesOutput()`, `buildModelsOutput()`, `buildRouterHelp()` (+ `formatModelIssues()`) |
| `/annotate-plan [path]` | multi-line template | n/a (the model executes the template) | n/a |

`/router` subcommands: `enforce <off\|advisory\|enforced>`, `overrides`, `models [provider]`, and bare (status + inline model validation).

---

## Implementation checklist

- [ ] Register commands in the `config` hook (`opencodeConfig.command`).
- [ ] Handle execution in `command.execute.before` via `input.command` / `input.arguments`.
- [ ] Push responses to `output.parts` as `{ type: "text", text }`.
- [ ] Handle empty arguments (show help / current state).
- [ ] Persist with `writeState()` and call `invalidateConfigCache()` after changes.
- [ ] Read config via `loadConfig()` (cached).
- [ ] Keep response rendering pure (see `src/commands/output.ts`) and the mutation in the handler.
- [ ] Format responses as Markdown. Don't use `tui.showToast()` for feedback.

---

## Common questions

- **Register a command?** Add it in the `config` hook; handle it in `command.execute.before`.
- **Read arguments?** `input.arguments` (string) in the handler.
- **Return a response?** Push `{ type: "text" as const, text }` to `output.parts`.
- **Persist state?** `writeState()` → `~/.config/opencode/*.state.json`, then `invalidateConfigCache()`.
- **`config` vs `command.execute.before`?** `config` runs once at load to register; `command.execute.before` runs on every command execution.
- **Inject into the system prompt?** Append to `output.system` in `experimental.chat.system.transform`.
