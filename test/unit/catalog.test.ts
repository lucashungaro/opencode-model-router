import { describe, it, expect } from "vitest";
import {
  normalizeCatalog,
  isCatalogEmpty,
  parseModelRef,
  editDistance,
  suggestModels,
  validateModels,
  type Catalog,
} from "../../src/router/catalog";
import type { RouterConfig } from "../../src/router/config";

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
