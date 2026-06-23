// ---------------------------------------------------------------------------
// src/commands/output.ts — pure renderers for the plugin's slash commands.
//
// Every function here is PURE: config/data in, markdown string out. No state
// mutation, no fs, no SDK. The command handlers in index.ts decide what to do
// (parse args, persist state via the config save* helpers, fetch the catalog)
// and then call these to format the result.
// ---------------------------------------------------------------------------

import type { RouterConfig, TierConfig, ModeConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import type { Catalog, ModelIssue } from "../router/catalog";

// --- agent registration -----------------------------------------------------

/** Provider-specific agent options (thinking/reasoning) derived from a tier. */
export function buildAgentOptions(tier: TierConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = {};

  if (tier.thinking?.budgetTokens) {
    opts.budget_tokens = tier.thinking.budgetTokens;
  }
  if (tier.reasoning?.effort) {
    opts.reasoning_effort = tier.reasoning.effort;
  }
  if (tier.reasoning?.summary) {
    opts.reasoning_summary = tier.reasoning.summary;
  }

  return opts;
}

// --- /tiers -----------------------------------------------------------------

export function buildTiersOutput(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [
    `# Model Delegation Tiers`,
    `Active preset: **${cfg.activePreset}**\n`,
  ];

  for (const [name, tier] of Object.entries(tiers)) {
    const thinkingStr = tier.thinking
      ? ` | thinking: ${tier.thinking.budgetTokens} tokens`
      : tier.reasoning
        ? ` | reasoning: effort=${tier.reasoning.effort}`
        : "";
    lines.push(`## @${name} -> \`${tier.model}\`${thinkingStr}`);
    if (tier.description) lines.push(tier.description);
    lines.push(`Steps: ${tier.steps ?? "default"}`);
    const whenToUse = tier.whenToUse ?? [];
    lines.push(whenToUse.length ? `Use when: ${whenToUse.join(", ")}\n` : "");
  }

  lines.push("## Delegation Rules");
  cfg.rules.forEach((r) => lines.push(`- ${r}`));
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push(`Switch with: \`/preset <name>\``);
  lines.push(`Edit \`tiers.json\` to customize.`);

  return lines.join("\n");
}

// --- /preset ----------------------------------------------------------------

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

/** Confirmation for a successful switch. `cfg.activePreset` must already be updated. */
export function buildPresetSwitched(cfg: RouterConfig, name: string): string {
  const tiers = cfg.presets[name]!;
  const models = Object.entries(tiers)
    .map(([tier, t]) => `  @${tier} -> ${t.model}`)
    .join("\n");
  return [
    `Preset switched to **${name}**.`,
    "",
    models,
    "",
    "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
    "Restart OpenCode for subagent model registration to take effect.",
    "System prompt delegation rules update immediately.",
  ].join("\n");
}

export function buildUnknownPreset(cfg: RouterConfig, requested: string): string {
  return `Unknown preset: "${requested}". Available: ${Object.keys(cfg.presets).join(", ")}`;
}

// --- /budget ----------------------------------------------------------------

export function buildNoModes(): string {
  return 'No modes configured in tiers.json. Add a "modes" section to enable budget mode.';
}

export function buildBudgetList(cfg: RouterConfig): string {
  const modes = cfg.modes ?? {};
  const currentMode = cfg.activeMode || "normal";
  const lines = ["# Routing Modes\n"];
  for (const [name, mode] of Object.entries(modes)) {
    const active = name === currentMode ? " <- active" : "";
    lines.push(
      `- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`,
    );
  }
  lines.push(`\nSwitch with: \`/budget <mode>\``);
  return lines.join("\n");
}

/** Confirmation for a successful mode switch. */
export function buildBudgetSwitched(mode: ModeConfig, name: string): string {
  return [
    `Routing mode switched to **${name}**.`,
    "",
    mode.description,
    `Default tier: @${mode.defaultTier}`,
    ...(mode.overrideRules?.length
      ? ["", "Active rules:", ...mode.overrideRules.map((r) => `- ${r}`)]
      : []),
    "",
    "Mode change takes effect immediately on the next message.",
  ].join("\n");
}

export function buildUnknownMode(
  modes: Record<string, ModeConfig>,
  requested: string,
): string {
  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
}

// --- /bypass ----------------------------------------------------------------

export function buildBypassMessage(bypassed: boolean): string {
  return bypassed
    ? "# Bypass: ON\n\nModel-router is **bypassed**. Delegation protocol, cap enforcement, and narration detection are disabled. The model will run without routing rules until you run `/bypass off` or restart OpenCode."
    : "# Bypass: OFF\n\nModel-router is **active**. Delegation protocol and all enforcement rules are in effect.";
}

// --- /router enforce | overrides | help -------------------------------------

export function buildEnforceSet(mode: "off" | "advisory" | "enforced"): string {
  const desc =
    mode === "off"
      ? "Hard-block guard disabled (default routing behaviour)."
      : mode === "advisory"
        ? "Guard evaluates and surfaces banners but never hard-blocks."
        : "Guard hard-blocks subagent tool calls that violate budget / redundancy / self-script policy.";
  return [
    `Enforcement mode set to **${mode}** and persisted.`,
    "",
    desc,
    "",
    "Note: the `MODEL_ROUTER_ENFORCE` env var, when set to `0` or `1`, overrides this setting.",
  ].join("\n");
}

export function buildEnforceStatus(current: string): string {
  return [
    `Current enforcement mode: **${current}**`,
    "",
    "Usage: `/router enforce <off|advisory|enforced>`",
  ].join("\n");
}

export function buildRouterHelp(current: string): string {
  return [
    `# Model Router`,
    `Enforcement: **${current}**`,
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set hard-block enforcement (persisted)",
    "- `/router overrides` — show the global + project override file paths and precedence",
    "- `/router models [provider]` — list valid model ids from your configured providers",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");
}

export interface OverridesView {
  globalPath: string;
  globalPresent: boolean;
  localPath: string;
  localPresent: boolean;
  foundLocal: boolean;
  activePreset: string;
}

export function buildOverridesOutput(v: OverridesView): string {
  const mark = (present: boolean) => (present ? "present" : "absent");
  const localNote = v.foundLocal
    ? ""
    : ` _(create at \`${v.localPath}\`; the project file is searched upward from the working dir to the repo root)_`;
  return [
    `# Model Router — config overrides`,
    "",
    "Config is loaded lowest→highest priority; each layer deep-merges over the previous one:",
    "",
    "1. bundled `tiers.json` (defaults)",
    `2. global — \`${v.globalPath}\` _(${mark(v.globalPresent)})_`,
    `3. project — \`${v.localPath}\` _(${mark(v.localPresent)})_${localNote}`,
    "",
    `Active preset: **${v.activePreset}**. Run \`/tiers\` to see the effective models after merging.`,
    "",
    "Create either file to customize models/tiers/presets without editing the cached `tiers.json`. Objects merge recursively; arrays and scalars are replaced.",
  ].join("\n");
}

// --- /router models | validation --------------------------------------------

/** Render the live model catalog (optionally filtered to one provider). */
export function buildModelsOutput(catalog: Catalog | null, filter: string): string {
  if (!catalog) {
    return "Model catalog unavailable — could not query opencode's providers.";
  }
  if (catalog.providers.length === 0) {
    return "No providers are configured/authenticated in opencode.";
  }
  const f = filter.trim().toLowerCase();
  const providers = f
    ? catalog.providers.filter((p) => p.id.toLowerCase() === f)
    : catalog.providers;
  if (providers.length === 0) {
    return `No configured provider matches \`${filter.trim()}\`. Available: ${catalog.providers
      .map((p) => p.id)
      .join(", ")}.`;
  }

  const lines: string[] = ["# Model Router — available models", ""];
  for (const p of providers) {
    const name = p.name && p.name !== p.id ? ` (${p.name})` : "";
    const def = p.defaultModel ? ` — default: \`${p.id}/${p.defaultModel}\`` : "";
    lines.push(`## ${p.id}${name}${def}`);
    const sorted = [...p.models].sort((a, b) => a.id.localeCompare(b.id));
    if (sorted.length === 0) {
      lines.push("- _(no models)_");
    } else {
      for (const m of sorted) {
        const flag = m.status && m.status !== "active" ? ` _(${m.status})_` : "";
        lines.push(`- \`${p.id}/${m.id}\`${flag}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "Paste any id above into an overrides file (`/router overrides` shows where).",
  );
  return lines.join("\n");
}

/** Render model-validation issues for the active preset as a markdown block. */
export function formatModelIssues(issues: ModelIssue[]): string {
  const lines: string[] = ["⚠ **Model issues in the active preset:**"];
  for (const it of issues) {
    const what =
      it.kind === "provider-unknown"
        ? `provider \`${it.providerId}\` is not configured/authenticated`
        : it.kind === "model-deprecated"
          ? `\`${it.ref}\` is **deprecated**`
          : `\`${it.ref}\` was not found`;
    let line = `- @${it.tier}: ${what}.`;
    if (it.suggestions.length > 0) {
      line += ` Try: ${it.suggestions.map((s) => `\`${s}\``).join(", ")}.`;
    }
    lines.push(line);
  }
  lines.push(
    "",
    "Set a replacement in your overrides file (`/router overrides`), then re-run `/router`.",
  );
  return lines.join("\n");
}
