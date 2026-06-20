import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  deepMerge,
  loadConfig,
  invalidateConfigCache,
  overridePath,
} from "../../src/router/config";

// ---------------------------------------------------------------------------
// deepMerge — pure unit tests
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
  it("merges nested objects key-by-key, leaving untouched keys intact", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const out = deepMerge(base, { a: { y: 9 } });
    expect(out).toEqual({ a: { x: 1, y: 9 }, b: 3 });
  });

  it("replaces arrays wholesale (no concatenation)", () => {
    const out = deepMerge({ list: [1, 2, 3] }, { list: [9] });
    expect(out).toEqual({ list: [9] });
  });

  it("replaces scalars", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("skips undefined override values so base survives", () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: undefined })).toEqual({ a: 1, b: 2 });
  });

  it("returns the override when either side is not a plain object", () => {
    expect(deepMerge(5, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(deepMerge({ a: 1 }, null)).toBe(null);
  });

  it("preserves sibling tier fields when overriding only one key (canonical case)", () => {
    const base = {
      heavy: { model: "old", variant: "high", costRatio: 20, steps: 120 },
    };
    const out = deepMerge(base, { heavy: { model: "new" } }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out.heavy).toEqual({
      model: "new",
      variant: "high",
      costRatio: 20,
      steps: 120,
    });
  });

  it("does not mutate the base object", () => {
    const base = { a: { x: 1 } };
    deepMerge(base, { a: { x: 2 } });
    expect(base.a.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — override file integration (HOME redirected to a temp dir so the
// real ~/.config/opencode files are never touched).
// ---------------------------------------------------------------------------

describe("loadConfig — user overrides file", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    tmpHome = join(
      tmpdir(),
      `oc-mr-overrides-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    invalidateConfigCache();
  });

  function writeOverride(content: string): void {
    const p = overridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
    invalidateConfigCache();
  }

  it("returns the bundled config unchanged when no override file exists", () => {
    const cfg = loadConfig();
    expect(cfg.presets["github-copilot"]!.heavy!.model).toBe(
      "github-copilot/claude-opus-4.8",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("deep-merges a single tier model, preserving sibling fields", () => {
    writeOverride(
      JSON.stringify({
        presets: {
          "github-copilot": { heavy: { model: "github-copilot/custom-opus" } },
        },
      }),
    );
    const heavy = loadConfig().presets["github-copilot"]!.heavy!;
    expect(heavy.model).toBe("github-copilot/custom-opus");
    // sibling fields from the bundled config survive the merge
    expect(heavy.variant).toBe("high");
    expect(heavy.costRatio).toBe(20);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("can add an entirely new preset", () => {
    writeOverride(
      JSON.stringify({
        presets: {
          local: {
            fast: {
              model: "ollama/llama3",
              description: "local fast",
              whenToUse: ["recon"],
            },
          },
        },
      }),
    );
    expect(loadConfig().presets.local!.fast!.model).toBe("ollama/llama3");
  });

  it("warns and falls back to bundled config on invalid JSON", () => {
    writeOverride("{ not valid json ");
    const cfg = loadConfig();
    expect(cfg.presets["github-copilot"]!.heavy!.model).toBe(
      "github-copilot/claude-opus-4.8",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid JSON"),
    );
  });

  it("warns and falls back when the override root is not an object", () => {
    writeOverride(JSON.stringify(["not", "an", "object"]));
    const cfg = loadConfig();
    expect(cfg.presets.anthropic!.fast!.model).toBe("anthropic/claude-haiku-4-5");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected a JSON object at root"),
    );
  });

  it("warns and falls back when the merged config fails validation", () => {
    // model must be a non-empty string; a number makes the merged config invalid
    writeOverride(
      JSON.stringify({ presets: { anthropic: { fast: { model: 123 } } } }),
    );
    const cfg = loadConfig();
    expect(cfg.presets.anthropic!.fast!.model).toBe("anthropic/claude-haiku-4-5");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("merged config is invalid"),
    );
  });
});
