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
  buildOverridesOutput,
  buildRouterHelp,
} from "../../src/commands/output";
import type { RouterConfig, ModeConfig } from "../../src/router/config";

// A minimal config is enough: these renderers only read what they print.
function cfg(over: Partial<RouterConfig> = {}): RouterConfig {
  return {
    activePreset: "alpha",
    defaultTier: "medium",
    rules: ["r1", "r2"],
    presets: {
      alpha: {
        fast: { model: "p/fast-m", description: "d-fast", steps: 30, whenToUse: ["a", "b"] },
        heavy: { model: "p/heavy-m", description: "d-heavy", steps: 120, whenToUse: ["c"] },
      },
      beta: { fast: { model: "q/other-m" } },
    },
    ...over,
  } as RouterConfig;
}

describe("buildAgentOptions", () => {
  it("returns an empty object when the tier declares neither block", () => {
    expect(buildAgentOptions({ model: "m" } as never)).toEqual({});
  });

  it("maps anthropic thinking budget", () => {
    expect(
      buildAgentOptions({ model: "m", thinking: { budgetTokens: 4096 } } as never),
    ).toEqual({ budget_tokens: 4096 });
  });

  it("maps openai reasoning effort and summary", () => {
    expect(
      buildAgentOptions({
        model: "m",
        reasoning: { effort: "high", summary: "auto" },
      } as never),
    ).toEqual({ reasoning_effort: "high", reasoning_summary: "auto" });
  });
});

describe("buildTiersOutput", () => {
  it("lists each tier with model, steps and use cases", () => {
    const out = buildTiersOutput(cfg());
    expect(out).toContain("Active preset: **alpha**");
    expect(out).toContain("## @fast -> `p/fast-m`");
    expect(out).toContain("Steps: 30");
    expect(out).toContain("Use when: a, b");
    expect(out).toContain("Default tier: @medium");
  });

  // A preset defined in an overrides file may carry only `model`.
  it("omits description and use cases when the tier has none", () => {
    const out = buildTiersOutput(
      cfg({ presets: { alpha: { fast: { model: "p/bare" } } } } as never),
    );
    expect(out).toContain("## @fast -> `p/bare`");
    expect(out).toContain("Steps: default");
    expect(out).not.toContain("Use when:");
    expect(out).not.toContain("undefined");
  });

  it("renders thinking and reasoning suffixes", () => {
    const withThinking = buildTiersOutput(
      cfg({
        presets: { alpha: { fast: { model: "m", thinking: { budgetTokens: 99 } } } },
      } as never),
    );
    expect(withThinking).toContain("| thinking: 99 tokens");
    const withReasoning = buildTiersOutput(
      cfg({
        presets: { alpha: { fast: { model: "m", reasoning: { effort: "low" } } } },
      } as never),
    );
    expect(withReasoning).toContain("| reasoning: effort=low");
  });
});

describe("preset renderers", () => {
  it("marks the active preset in the list and shows bare model names", () => {
    const out = buildPresetList(cfg());
    expect(out).toContain("- **alpha** <- active:");
    expect(out).toContain("fast: fast-m"); // provider prefix stripped
    expect(out).toContain("- **beta**:");
    expect(out).not.toContain("beta** <- active");
  });

  it("lists the switched preset's tiers with full model ids", () => {
    const out = buildPresetSwitched(cfg(), "beta");
    expect(out).toContain("Preset switched to **beta**.");
    expect(out).toContain("@fast -> q/other-m");
  });

  it("names the available presets when the requested one is unknown", () => {
    expect(buildUnknownPreset(cfg(), "zzz")).toBe(
      'Unknown preset: "zzz". Available: alpha, beta',
    );
  });
});

describe("budget renderers", () => {
  const modes: Record<string, ModeConfig> = {
    normal: { defaultTier: "medium", description: "balanced" } as ModeConfig,
    thrifty: {
      defaultTier: "fast",
      description: "cheap",
      overrideRules: ["x"],
    } as ModeConfig,
  };

  it("explains how to enable modes when none are configured", () => {
    expect(buildNoModes()).toContain('Add a "modes" section');
  });

  it("defaults the active marker to normal when no mode is set", () => {
    const out = buildBudgetList(cfg({ modes } as never));
    expect(out).toContain("- **normal** <- active:");
    expect(out).toContain("- **thrifty**:");
  });

  it("follows activeMode when one is set", () => {
    const out = buildBudgetList(cfg({ modes, activeMode: "thrifty" } as never));
    expect(out).toContain("- **thrifty** <- active:");
  });

  it("includes override rules only when the mode declares them", () => {
    expect(buildBudgetSwitched(modes.thrifty!, "thrifty")).toContain("Active rules:");
    expect(buildBudgetSwitched(modes.normal!, "normal")).not.toContain("Active rules:");
  });

  it("names the available modes when the requested one is unknown", () => {
    expect(buildUnknownMode(modes, "zzz")).toBe(
      'Unknown mode: "zzz". Available: normal, thrifty',
    );
  });
});

describe("router and bypass renderers", () => {
  it("renders bypass from the resulting state, not the argument", () => {
    expect(buildBypassMessage(true)).toContain("# Bypass: ON");
    expect(buildBypassMessage(true)).toContain("**bypassed**");
    expect(buildBypassMessage(false)).toContain("# Bypass: OFF");
    expect(buildBypassMessage(false)).toContain("**active**");
  });

  it("describes each enforcement mode distinctly", () => {
    expect(buildEnforceSet("off")).toContain("Hard-block guard disabled");
    expect(buildEnforceSet("advisory")).toContain("never hard-blocks");
    expect(buildEnforceSet("enforced")).toContain("hard-blocks subagent tool calls");
    for (const m of ["off", "advisory", "enforced"] as const) {
      expect(buildEnforceSet(m)).toContain("MODEL_ROUTER_ENFORCE");
    }
  });

  it("shows usage alongside the current mode", () => {
    const out = buildEnforceStatus("advisory");
    expect(out).toContain("**advisory**");
    expect(out).toContain("/router enforce <off|advisory|enforced>");
  });

  it("points at the overrides command from the help output", () => {
    expect(buildRouterHelp("off")).toContain("Enforcement: **off**");
    expect(buildRouterHelp("off")).toContain("/router overrides");
  });
});

describe("buildOverridesOutput", () => {
  const view = {
    globalPath: "/g/overrides.jsonc",
    globalPresent: true,
    localPath: "/p/.opencode/overrides.jsonc",
    localPresent: false,
    localFound: false,
    activePreset: "alpha",
  };

  it("marks each layer present or absent and names the active preset", () => {
    const out = buildOverridesOutput(view);
    expect(out).toContain("`/g/overrides.jsonc` _(present)_");
    expect(out).toContain("`/p/.opencode/overrides.jsonc` _(absent)_");
    expect(out).toContain("Active preset: **alpha**");
  });

  // The create-location hint is only meaningful when no project file was found.
  it("suggests where to create the project file only when none was found", () => {
    expect(buildOverridesOutput(view)).toContain("create at");
    expect(
      buildOverridesOutput({ ...view, localFound: true, localPresent: true }),
    ).not.toContain("create at");
  });
});
