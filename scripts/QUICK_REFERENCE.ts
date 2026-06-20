/**
 * QUICK REFERENCE: Custom Slash Commands in OpenCode Plugins
 *
 * Source: src/index.ts (factory + hooks) and src/commands/output.ts (renderers).
 * Reference Documentation: docs/COMMAND_PATTERNS.md
 *
 * Illustrative snippets — symbol names match the current code; this file is not
 * compiled (scripts/ is outside the tsconfig include).
 */

// ============================================================================
// 1. COMMAND REGISTRATION (in the config hook)
// ============================================================================

const modelRouterPlugin = {
  config: async (opencodeConfig: any) => {
    opencodeConfig.command ??= {};

    // No-argument command
    opencodeConfig.command["tiers"] = {
      template: "", // empty = no arguments
      description: "Show model delegation tiers and rules",
    };

    // Command with arguments
    opencodeConfig.command["preset"] = {
      template: "$ARGUMENTS",
      description: "Show or switch model presets (e.g., /preset openai)",
    };

    // Subcommand-style command
    opencodeConfig.command["router"] = {
      template: "$ARGUMENTS",
      description: "Model-router controls (/router enforce|overrides|models)",
    };

    // Multi-line template the model executes
    opencodeConfig.command["annotate-plan"] = {
      template: ["Annotate the plan with tier directives...", 'File: "$ARGUMENTS"'].join("\n"),
      description: "Annotate a plan with tier directives",
    };
  },
};

// ============================================================================
// 2. COMMAND HANDLER (command.execute.before hook)
// ============================================================================

const handleCommands = {
  "command.execute.before": async (input: any, output: any) => {
    // input.command   : string (name without /)
    // input.arguments : string | null (raw user input)
    // output.parts    : push { type: "text", text } to respond
    const args = (input.arguments ?? "").trim();
    const reload = () => { try { cfg = loadConfig(); } catch {} };
    const push = (text: string) =>
      output.parts.push({ type: "text" as const, text });

    switch (input.command) {
      case "tiers":  reload(); push(buildTiersOutput(cfg)); break;
      case "preset": reload(); push(handlePreset(args)); break;       // handler closure
      case "budget": reload(); push(handleBudget(args)); break;
      case "bypass":           push(handleBypass(args)); break;
      case "router": reload(); push(await handleRouterCommand(args)); break;
    }
  },
};

// ============================================================================
// 3. ARGUMENT PARSING (handler closure decides + mutates; renderers are pure)
// ============================================================================

// Closure in src/index.ts (uses the freshly-reloaded cfg):
const handleBudget = (args: string): string => {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) return buildNoModes();
  const requested = args.trim().toLowerCase();          // normalize
  if (!requested) return buildBudgetList(cfg);           // no args → show state
  const mode = modes[requested];
  if (!mode) return buildUnknownMode(modes, requested);  // validate
  saveActiveMode(requested);                             // mutate + persist
  return buildBudgetSwitched(mode, requested);           // confirm
};
// buildNoModes/buildBudgetList/buildUnknownMode/buildBudgetSwitched live in
// src/commands/output.ts and are pure (data in → markdown out).

// ============================================================================
// 4. STATE PERSISTENCE & CACHE INVALIDATION (src/router/config.ts)
// ============================================================================

let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

export function invalidateConfigCache(): void {
  _configDirty = true;
}

export function loadConfig(): RouterConfig {
  if (_cachedConfig && !_configDirty) return _cachedConfig;
  // Effective config = bundled tiers.json → global overrides → project
  // overrides → persisted state (see config.ts for the full merge).
  _cachedConfig = buildEffectiveConfig();
  _configDirty = false;
  return _cachedConfig;
}

// The save* writers live in config.ts alongside writeState/invalidateConfigCache.
export function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) return;
  cfg.activePreset = resolved;
  writeState({ activePreset: resolved }); // ~/.config/opencode/opencode-model-router.state.json
  invalidateConfigCache();                // force reload on next access
}

// ============================================================================
// 5. SYSTEM PROMPT INJECTION (every message)
// ============================================================================

const systemPromptInjection = {
  "experimental.chat.system.transform": async (_input: any, output: any) => {
    if (bypassed) return;
    try { cfg = loadConfig(); } catch { /* keep last known config */ }
    // Only inject for the orchestrator, not subagent sessions:
    if (sessionStore.isSubagent(_input?.sessionID)) return;
    const enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
    // assembleSystemPrompt wraps buildDelegationProtocol + Claude prefixes + DoD section.
    output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
  },
};

// ============================================================================
// 6. USER FEEDBACK (pure renderers in src/commands/output.ts)
// ============================================================================

export function buildPresetList(cfg: RouterConfig): string {
  const lines = ["# Available Presets\n"];
  for (const [name, tiers] of Object.entries(cfg.presets)) {
    const active = name === cfg.activePreset ? " <- active" : "";
    const models = Object.entries(tiers)
      .map(([tier, t]) => `${tier}: ${t.model.split("/").pop()}`)
      .join(", ");
    lines.push(`- **${name}**${active}: ${models}`);
  }
  lines.push(`\nSwitch with: \`/preset <name>\``);
  return lines.join("\n");
}

// ============================================================================
// 7. COMPLETE MINIMAL EXAMPLE
// ============================================================================

import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const MinimalPlugin: Plugin = async (_ctx: PluginInput) => {
  let state = { mode: "normal" };

  return {
    config: async (opencodeConfig: any) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command["mycommand"] = {
        template: "$ARGUMENTS",
        description: "My custom command",
      };
    },

    "command.execute.before": async (input: any, output: any) => {
      if (input.command !== "mycommand") return;
      const args = (input.arguments ?? "").trim();
      const push = (text: string) =>
        output.parts.push({ type: "text" as const, text });

      if (!args) return push(`Current mode: ${state.mode}\nUsage: /mycommand <mode>`);
      if (!["normal", "fast", "slow"].includes(args)) {
        return push(`Unknown mode. Available: normal, fast, slow`);
      }
      state.mode = args;
      push(`Mode changed to: **${args}**`);
    },
  };
};

// ============================================================================
// KEY TAKEAWAYS
// ============================================================================
/*
1. REGISTER: opencodeConfig.command["name"] = { template, description }
   - template: "" (no args) | "$ARGUMENTS" | multi-line string the model runs

2. DISPATCH: "command.execute.before" — switch on input.command; read
   input.arguments; push { type: "text", text } to output.parts.

3. SEPARATE concerns: handler closures decide + persist; rendering is pure
   (src/commands/output.ts).

4. PERSIST: save* helpers in src/router/config.ts → writeState() +
   invalidateConfigCache(); state file is separate from tiers.json.

5. INJECT: "experimental.chat.system.transform" → assembleSystemPrompt(...);
   skip subagent sessions.

6. FEEDBACK: Markdown strings; no tui.showToast().
*/
