import { describe, it, expect } from "vitest";
import {
  buildAgentOptions,
  buildTiersOutput,
  buildPresetList,
  buildPresetSwitched,
  buildUnknownPreset,
  buildNoModes,
  buildBudgetList,
  buildBudgetSwitched,
  buildUnknownMode,
  buildBypassMessage,
  buildEnforceSet,
  buildEnforceStatus,
  buildRouterHelp,
  buildOverridesOutput,
  buildModelsOutput,
  formatModelIssues,
} from "../../src/commands/output";
import type { RouterConfig } from "../../src/router/config";
import type { Catalog, ModelIssue } from "../../src/router/catalog";

const cfg = {
  activePreset: "anthropic",
  presets: {
    anthropic: {
      fast: { model: "anthropic/claude-haiku-4-5", description: "fast tier", whenToUse: ["recon"], steps: 30 },
      heavy: { model: "anthropic/claude-opus-4-8", description: "heavy tier", whenToUse: ["arch"] },
    },
    openai: {
      fast: { model: "openai/gpt-mini", description: "oa fast", whenToUse: [] },
    },
  },
  rules: ["r1", "r2"],
  defaultTier: "fast",
  modes: {
    normal: { defaultTier: "medium", description: "balanced" },
    budget: { defaultTier: "fast", description: "cheap", overrideRules: ["o1"] },
  },
  activeMode: "normal",
} as unknown as RouterConfig;

describe("buildAgentOptions", () => {
  it("maps thinking + reasoning, omits empties", () => {
    expect(buildAgentOptions({ thinking: { budgetTokens: 10000 } } as any)).toEqual({
      budget_tokens: 10000,
    });
    expect(
      buildAgentOptions({ reasoning: { effort: "high", summary: "auto" } } as any),
    ).toEqual({ reasoning_effort: "high", reasoning_summary: "auto" });
    expect(buildAgentOptions({} as any)).toEqual({});
  });
});

describe("buildTiersOutput", () => {
  it("renders the active preset, tiers, and rules", () => {
    const out = buildTiersOutput(cfg);
    expect(out).toContain("Active preset: **anthropic**");
    expect(out).toContain("@fast -> `anthropic/claude-haiku-4-5`");
    expect(out).toContain("Steps: 30");
    expect(out).toContain("- r1");
    expect(out).toContain("Default tier: @fast");
  });

  it("renders a minimal (model-only) tier without leaking 'undefined'", () => {
    const minimal = {
      activePreset: "local",
      presets: { local: { fast: { model: "local/qwen" } } },
      rules: [],
      defaultTier: "fast",
    } as unknown as RouterConfig;
    const out = buildTiersOutput(minimal);
    expect(out).toContain("@fast -> `local/qwen`");
    expect(out).not.toContain("undefined");
  });
});

describe("preset renderers", () => {
  it("lists presets and marks the active one", () => {
    const out = buildPresetList(cfg);
    expect(out).toContain("# Available Presets");
    expect(out).toContain("**anthropic** <- active");
    expect(out).toContain("**openai**:");
    // model basename only
    expect(out).toContain("claude-haiku-4-5");
  });

  it("renders a switch confirmation with full model ids", () => {
    const out = buildPresetSwitched(cfg, "anthropic");
    expect(out).toContain("Preset switched to **anthropic**");
    expect(out).toContain("@heavy -> anthropic/claude-opus-4-8");
  });

  it("renders unknown preset with the available list", () => {
    expect(buildUnknownPreset(cfg, "nope")).toBe(
      'Unknown preset: "nope". Available: anthropic, openai',
    );
  });
});

describe("budget renderers", () => {
  it("buildNoModes", () => {
    expect(buildNoModes()).toContain("No modes configured");
  });

  it("lists modes and marks the active one", () => {
    const out = buildBudgetList(cfg);
    expect(out).toContain("**normal** <- active");
    expect(out).toContain("(default tier: @fast)");
  });

  it("renders a switch confirmation including override rules", () => {
    const out = buildBudgetSwitched(cfg.modes!.budget, "budget");
    expect(out).toContain("Routing mode switched to **budget**");
    expect(out).toContain("Active rules:");
    expect(out).toContain("- o1");
  });

  it("renders unknown mode", () => {
    expect(buildUnknownMode(cfg.modes!, "nope")).toBe(
      'Unknown mode: "nope". Available: normal, budget',
    );
  });
});

describe("bypass + router renderers", () => {
  it("buildBypassMessage reflects state", () => {
    expect(buildBypassMessage(true)).toContain("# Bypass: ON");
    expect(buildBypassMessage(false)).toContain("# Bypass: OFF");
  });

  it("buildEnforceSet / buildEnforceStatus / buildRouterHelp", () => {
    expect(buildEnforceSet("advisory")).toContain("set to **advisory**");
    expect(buildEnforceStatus("off")).toContain("Current enforcement mode: **off**");
    const help = buildRouterHelp("enforced");
    expect(help).toContain("Enforcement: **enforced**");
    expect(help).toContain("/router models");
    expect(help).toContain("/router overrides");
  });

  it("buildOverridesOutput marks presence and adds a create-note when absent", () => {
    const present = buildOverridesOutput({
      globalPath: "/g.json",
      globalPresent: true,
      localPath: "/p.json",
      localPresent: true,
      foundLocal: true,
      activePreset: "anthropic",
    });
    expect(present).toContain("`/g.json` _(present)_");
    expect(present).toContain("`/p.json` _(present)_");
    expect(present).not.toContain("create at");

    const absent = buildOverridesOutput({
      globalPath: "/g.json",
      globalPresent: false,
      localPath: "/p.json",
      localPresent: false,
      foundLocal: false,
      activePreset: "anthropic",
    });
    expect(absent).toContain("_(absent)_");
    expect(absent).toContain("create at `/p.json`");
  });
});

describe("catalog renderers", () => {
  const catalog: Catalog = {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        defaultModel: "claude-sonnet-4-6",
        models: [
          { id: "claude-haiku-4-5", status: "active" },
          { id: "claude-opus-4-6", status: "deprecated" },
        ],
      },
    ],
  };

  it("buildModelsOutput lists ids, default, and status flags", () => {
    const out = buildModelsOutput(catalog, "");
    expect(out).toContain("default: `anthropic/claude-sonnet-4-6`");
    expect(out).toContain("`anthropic/claude-haiku-4-5`");
    expect(out).toContain("`anthropic/claude-opus-4-6` _(deprecated)_");
  });

  it("buildModelsOutput handles null / empty / no-match", () => {
    expect(buildModelsOutput(null, "")).toContain("catalog unavailable");
    expect(buildModelsOutput({ providers: [] }, "")).toContain(
      "No providers are configured",
    );
    expect(buildModelsOutput(catalog, "openai")).toContain(
      "No configured provider matches",
    );
  });

  it("formatModelIssues renders each kind with suggestions", () => {
    const issues: ModelIssue[] = [
      {
        tier: "heavy",
        ref: "anthropic/x",
        providerId: "anthropic",
        modelId: "x",
        kind: "model-missing",
        suggestions: ["anthropic/claude-opus-4-8"],
      },
    ];
    const out = formatModelIssues(issues);
    expect(out).toContain("@heavy");
    expect(out).toContain("was not found");
    expect(out).toContain("Try: `anthropic/claude-opus-4-8`");
  });
});
