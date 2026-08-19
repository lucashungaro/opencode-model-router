import { describe, it, expect } from "vitest";
import {
  findOrphanedStrongPatterns,
  normalizeCatalog,
  isCatalogEmpty,
  parseModelRef,
  editDistance,
  suggestModels,
  validateModels,
  type Catalog,
} from "../../src/router/catalog";
import { isStrongModel } from "../../src/router/prompts";
import type { PromptStyle, RouterConfig } from "../../src/router/config";

function cfgWith(models: Record<string, string>): RouterConfig {
  const fast = { model: models.fast, description: "", whenToUse: [] };
  const preset: Record<string, unknown> = {};
  for (const [tier, model] of Object.entries(models)) {
    preset[tier] = { model, description: "", whenToUse: [] };
  }
  void fast;
  return {
    activePreset: "p",
    presets: { p: preset },
    rules: [],
    defaultTier: "fast",
  } as unknown as RouterConfig;
}

const catalog: Catalog = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      defaultModel: "claude-sonnet-4-6",
      models: [
        { id: "claude-haiku-4-5", status: "active" },
        { id: "claude-sonnet-4-6", status: "active" },
        { id: "claude-opus-4-8", status: "active" },
        { id: "claude-opus-4-6", status: "deprecated" },
      ],
    },
  ],
};

describe("normalizeCatalog", () => {
  it("maps providers, models, and per-provider default", () => {
    const raw = {
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-haiku-4-5": { id: "claude-haiku-4-5", status: "active" },
            "claude-opus-4-6": { id: "claude-opus-4-6", status: "deprecated" },
          },
        },
      ],
      default: { anthropic: "claude-haiku-4-5" },
    };
    const cat = normalizeCatalog(raw);
    expect(cat.providers).toHaveLength(1);
    const p = cat.providers[0]!;
    expect(p.id).toBe("anthropic");
    expect(p.defaultModel).toBe("claude-haiku-4-5");
    expect(p.models.map((m) => m.id).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
    ]);
    expect(p.models.find((m) => m.id === "claude-opus-4-6")?.status).toBe(
      "deprecated",
    );
  });

  it("is defensive against missing/garbage payloads", () => {
    expect(normalizeCatalog(undefined).providers).toEqual([]);
    expect(normalizeCatalog(null).providers).toEqual([]);
    expect(normalizeCatalog({}).providers).toEqual([]);
    // provider without an id is skipped; model key used when id absent
    const cat = normalizeCatalog({
      providers: [{ name: "no id" }, { id: "x", models: { foo: {} } }],
    });
    expect(cat.providers).toHaveLength(1);
    expect(cat.providers[0]!.models[0]!.id).toBe("foo");
  });

  it("isCatalogEmpty reflects provider count", () => {
    expect(isCatalogEmpty({ providers: [] })).toBe(true);
    expect(isCatalogEmpty(catalog)).toBe(false);
  });
});

describe("parseModelRef", () => {
  it("splits on the first slash only", () => {
    expect(parseModelRef("anthropic/claude-opus-4.8")).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4.8",
    });
    expect(parseModelRef("openrouter/deepseek/deepseek-v3.2")).toEqual({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v3.2",
    });
  });

  it("rejects malformed refs", () => {
    expect(parseModelRef("noslash")).toBeUndefined();
    expect(parseModelRef("/leading")).toBeUndefined();
    expect(parseModelRef("trailing/")).toBeUndefined();
  });
});

describe("editDistance", () => {
  it("computes basic distances", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("claude-opus-4-6", "claude-opus-4-8")).toBe(1);
  });
});

describe("suggestModels", () => {
  it("ranks by closeness and de-prioritizes deprecated", () => {
    // limit 4 so all models appear and the deprecated ordering is observable
    const out = suggestModels("claude-opus-4-6", catalog.providers[0]!.models, 4);
    // closest non-deprecated first (opus-4-8 differs by one char); the exact
    // deprecated match is pushed to last despite distance 0
    expect(out[0]).toBe("claude-opus-4-8");
    expect(out[out.length - 1]).toBe("claude-opus-4-6");
  });

  it("respects the limit and excludes deprecated when active models fill it", () => {
    const out = suggestModels("claude-opus-4-6", catalog.providers[0]!.models, 3);
    expect(out).toHaveLength(3);
    expect(out).not.toContain("claude-opus-4-6");
  });
});

describe("validateModels", () => {
  it("returns no issues when every model is active", () => {
    const cfg = cfgWith({
      fast: "anthropic/claude-haiku-4-5",
      heavy: "anthropic/claude-opus-4-8",
    });
    expect(validateModels(cfg, catalog)).toEqual([]);
  });

  it("flags a missing model with closest suggestions", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-9-9" });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("model-missing");
    expect(issues[0]!.tier).toBe("heavy");
    expect(issues[0]!.suggestions[0]).toBe("anthropic/claude-opus-4-8");
  });

  it("flags a deprecated model and suggests active alternatives", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-4-6" });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("model-deprecated");
    expect(issues[0]!.suggestions).not.toContain("anthropic/claude-opus-4-6");
    expect(issues[0]!.suggestions[0]).toBe("anthropic/claude-opus-4-8");
  });

  it("flags an unconfigured provider", () => {
    const cfg = cfgWith({ fast: "openai/gpt-5" });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("provider-unknown");
    expect(issues[0]!.suggestions).toEqual([]);
  });

  it("never cries wolf when the catalog is empty (fetch failed)", () => {
    const cfg = cfgWith({ heavy: "anthropic/does-not-exist" });
    expect(validateModels(cfg, { providers: [] })).toEqual([]);
  });
});

describe("validateModels — fallback chains", () => {
  // A fallback chain is `providerId -> [presetName, ...]` (FallbackConfig), so
  // what can rot is a provider the catalog does not know and a chain entry that
  // names no real preset.
  function cfgFb(
    fallback: unknown,
    over: { tiers?: Record<string, string>; presets?: string[] } = {},
  ): RouterConfig {
    const preset: Record<string, unknown> = {};
    for (const [tier, model] of Object.entries(
      over.tiers ?? { heavy: "anthropic/claude-opus-4-8" },
    )) {
      preset[tier] = { model };
    }
    const presets: Record<string, unknown> = { p: preset };
    for (const extra of over.presets ?? []) presets[extra] = preset;
    return {
      activePreset: "p",
      presets,
      rules: [],
      defaultTier: "heavy",
      fallback,
    } as unknown as RouterConfig;
  }

  it("flags a chain keyed by a provider the catalog does not know", () => {
    const cfg = cfgFb({ global: { openai: ["p"] } });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("fallback-provider-unknown");
    expect(issues[0]!.scope).toBe("fallback");
    expect(issues[0]!.providerId).toBe("openai");
    expect(issues[0]!.tier).toBe("fallback.global");
  });

  it("flags a chain entry that names no defined preset, with suggestions", () => {
    const cfg = cfgFb({ global: { anthropic: ["cheap", "pro"] } }, { presets: ["pro"] });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("fallback-preset-unknown");
    expect(issues[0]!.chainTarget).toBe("cheap");
    expect(issues[0]!.ref).toBe("anthropic → cheap");
    expect(issues[0]!.suggestions).toContain("p");
  });

  it("does not report the same unknown provider twice (tier then fallback)", () => {
    const cfg = cfgFb(
      { global: { openai: ["p"] } },
      { tiers: { fast: "openai/gpt-5" } },
    );
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.scope).toBe("tier");
    expect(issues[0]!.kind).toBe("provider-unknown");
  });

  it("prefers the active preset's fallback map over the global one", () => {
    const cfg = cfgFb({
      global: { anthropic: ["ghost-global"] },
      presets: { p: { anthropic: ["ghost-preset"] } },
    });
    const issues = validateModels(cfg, catalog);
    expect(issues.map((i) => i.chainTarget)).toEqual(["ghost-preset"]);
    expect(issues[0]!.tier).toBe("fallback.presets.p");
  });

  it("ignores self-references, real presets, and malformed chain values", () => {
    const cfg = cfgFb({
      global: {
        anthropic: ["p", "pro", 7, "", null],
        "": ["ghost"],
      },
    }, { presets: ["pro"] });
    expect(validateModels(cfg, catalog)).toEqual([]);
  });

  it("survives a non-array chain and a non-object fallback", () => {
    expect(validateModels(cfgFb({ global: { anthropic: "pro" } }), catalog)).toEqual([]);
    expect(validateModels(cfgFb(undefined), catalog)).toEqual([]);
    expect(validateModels(cfgFb({}), catalog)).toEqual([]);
  });

  it("with an empty catalog: tier checks are skipped, config-only checks still run", () => {
    const cfg = cfgFb(
      { global: { openai: ["ghost"] } },
      { tiers: { heavy: "anthropic/does-not-exist" } },
    );
    const issues = validateModels(cfg, { providers: [] });
    // no tier issue (we could not see the catalog) and no unknown-provider
    // issue either — but the preset name is a config fact, catalog or not
    expect(issues.map((i) => i.kind)).toEqual(["fallback-preset-unknown"]);
    expect(issues[0]!.chainTarget).toBe("ghost");
  });

  it("stays silent for a config without any fallback (no regression)", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-4-8" });
    expect(validateModels(cfg, catalog)).toEqual([]);
    expect(validateModels(cfg, { providers: [] })).toEqual([]);
  });

  it("tags tier issues with scope 'tier'", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-9-9" });
    expect(validateModels(cfg, catalog)[0]!.scope).toBe("tier");
  });
});

describe("findOrphanedStrongPatterns", () => {
  function strongCfg(
    models: Record<string, string>,
    over: {
      strong?: string[];
      promptStyle?: Record<string, PromptStyle>;
    } = {},
  ): RouterConfig {
    const preset: Record<string, unknown> = {};
    for (const [tier, model] of Object.entries(models)) {
      preset[tier] = { model, promptStyle: over.promptStyle?.[tier] };
    }
    return {
      activePreset: "p",
      presets: { p: preset },
      rules: [],
      defaultTier: "fast",
      ...(over.strong ? { modelGenerations: { strong: over.strong } } : {}),
    } as unknown as RouterConfig;
  }

  it("returns nothing when every pattern matches some tier model", () => {
    const cfg = strongCfg(
      {
        fast: "anthropic/claude-haiku-4-5",
        heavy: "anthropic/claude-opus-4-8",
      },
      { strong: ["opus-4-8", "HAIKU-4-5"] },
    );
    expect(findOrphanedStrongPatterns(cfg)).toEqual([]);
  });

  it("flags the provider-rename case that silently downgrades prompt style", () => {
    // the rename `claude-opus-4-8` -> `opus-4.8` (dot) stops matching
    const cfg = strongCfg(
      { heavy: "anthropic/opus-4.8" },
      { strong: ["claude-fable-5", "opus-4-8"] },
    );
    expect(findOrphanedStrongPatterns(cfg)).toEqual([
      "claude-fable-5",
      "opus-4-8",
    ]);
    // and the downgrade it warns about is real
    expect(isStrongModel("anthropic/opus-4.8", cfg)).toBe(false);
  });

  it("matches case-insensitively, exactly like isStrongModel", () => {
    const cfg = strongCfg(
      { heavy: "anthropic/CLAUDE-Opus-4-8" },
      { strong: ["opus-4-8"] },
    );
    expect(findOrphanedStrongPatterns(cfg)).toEqual([]);
    expect(isStrongModel("anthropic/CLAUDE-Opus-4-8", cfg)).toBe(true);
  });

  it("falls back to the default pattern list when none is configured", () => {
    const cfg = strongCfg({ fast: "openai/gpt-5" });
    // DEFAULT_STRONG_MODEL_PATTERNS: claude-fable-5, claude-mythos-5, opus-4-8
    expect(findOrphanedStrongPatterns(cfg)).toEqual([
      "claude-fable-5",
      "claude-mythos-5",
      "opus-4-8",
    ]);
  });

  it("stays silent when no tier resolves its prompt style by auto", () => {
    const cfg = strongCfg(
      { fast: "openai/gpt-5", heavy: "openai/gpt-5-pro" },
      {
        strong: ["opus-4-8"],
        promptStyle: { fast: "prescriptive", heavy: "goal-oriented" },
      },
    );
    expect(findOrphanedStrongPatterns(cfg)).toEqual([]);
    // one tier back on auto is enough to make the orphan matter again
    const auto = strongCfg(
      { fast: "openai/gpt-5", heavy: "openai/gpt-5-pro" },
      { strong: ["opus-4-8"], promptStyle: { fast: "prescriptive" } },
    );
    expect(findOrphanedStrongPatterns(auto)).toEqual(["opus-4-8"]);
  });

  it("ignores garbage entries and de-duplicates", () => {
    const cfg = strongCfg(
      { fast: "openai/gpt-5" },
      { strong: ["opus-4-8", "opus-4-8", "", null as unknown as string] },
    );
    expect(findOrphanedStrongPatterns(cfg)).toEqual(["opus-4-8"]);
  });
});
