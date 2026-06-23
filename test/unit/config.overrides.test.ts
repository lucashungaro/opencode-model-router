import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  deepMerge,
  loadConfig,
  invalidateConfigCache,
  overridePath,
  localOverridePath,
  findProjectOverride,
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

  it("supports comments and trailing commas in the overrides file", () => {
    writeOverride(`{
      // override just the heavy model for github-copilot
      "presets": {
        "github-copilot": {
          "heavy": { "model": "github-copilot/custom-opus" }, /* trailing comma → */
        },
      },
    }`);
    expect(loadConfig().presets["github-copilot"]!.heavy!.model).toBe(
      "github-copilot/custom-opus",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("can add an entirely new preset with only `model` per tier", () => {
    writeOverride(
      JSON.stringify({
        presets: {
          local: {
            fast: { model: "local/qwen3.6-27b-mtp" },
            medium: { model: "local/qwen3.6-27b-mtp" },
            heavy: { model: "local/qwen3.6-27b-mtp" },
          },
        },
        activePreset: "local",
      }),
    );
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("local");
    expect(cfg.presets.local!.heavy!.model).toBe("local/qwen3.6-27b-mtp");
    expect(warnSpy).not.toHaveBeenCalled(); // no validation failure → layer not dropped
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
      expect.stringContaining("must be a non-empty string"),
    );
  });
});

// ---------------------------------------------------------------------------
// loadConfig — global + project-local override hierarchy. HOME drives the global
// file; process.cwd() drives the project-local file. Both are redirected to
// temp dirs so the real environment is never touched.
// ---------------------------------------------------------------------------

describe("loadConfig — global + project override hierarchy", () => {
  let tmpHome: string;
  let tmpProject: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedCwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedCwd = process.cwd();
    const stamp = `${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    tmpHome = join(tmpdir(), `oc-mr-home-${stamp}`);
    tmpProject = join(tmpdir(), `oc-mr-proj-${stamp}`);
    mkdirSync(tmpHome, { recursive: true });
    mkdirSync(tmpProject, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.chdir(tmpProject);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    for (const d of [tmpHome, tmpProject]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    invalidateConfigCache();
  });

  function writeGlobal(obj: unknown): void {
    const p = overridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj), "utf-8");
  }

  function writeLocal(obj: unknown): void {
    const p = localOverridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj), "utf-8");
  }

  it("localOverridePath resolves to <cwd>/.opencode/opencode-model-router.overrides.jsonc", () => {
    expect(localOverridePath()).toBe(
      join(process.cwd(), ".opencode", "opencode-model-router.overrides.jsonc"),
    );
  });

  it("applies a project-local override", () => {
    writeLocal({
      presets: { anthropic: { fast: { model: "anthropic/project-fast" } } },
    });
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/project-fast",
    );
  });

  it("project-local wins over global for the same key", () => {
    writeGlobal({
      presets: { anthropic: { fast: { model: "anthropic/global-fast" } } },
    });
    writeLocal({
      presets: { anthropic: { fast: { model: "anthropic/project-fast" } } },
    });
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/project-fast",
    );
  });

  it("merges distinct keys from both layers", () => {
    writeGlobal({
      presets: { anthropic: { fast: { model: "anthropic/global-fast" } } },
    });
    writeLocal({
      presets: { anthropic: { heavy: { model: "anthropic/project-heavy" } } },
    });
    invalidateConfigCache();
    const anthropic = loadConfig().presets.anthropic!;
    expect(anthropic.fast!.model).toBe("anthropic/global-fast");
    expect(anthropic.heavy!.model).toBe("anthropic/project-heavy");
  });

  it("a broken global file does not discard a valid project file", () => {
    // global makes the merged config invalid; project is fine on its own
    writeGlobal({ presets: { anthropic: { fast: { model: 123 } } } });
    writeLocal({
      presets: { anthropic: { medium: { model: "anthropic/project-medium" } } },
    });
    invalidateConfigCache();
    const anthropic = loadConfig().presets.anthropic!;
    expect(anthropic.medium!.model).toBe("anthropic/project-medium");
    // fell back to the bundled fast model (global dropped)
    expect(anthropic.fast!.model).toBe("anthropic/claude-haiku-4-5");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("combined overrides are invalid"),
    );
  });

  it("a broken project file keeps the valid global file", () => {
    writeGlobal({
      presets: { anthropic: { fast: { model: "anthropic/global-fast" } } },
    });
    writeLocal({ presets: { anthropic: { fast: { model: 999 } } } });
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/global-fast",
    );
  });
});

// ---------------------------------------------------------------------------
// findProjectOverride — upward search from cwd, bounded by the project root.
// ---------------------------------------------------------------------------

describe("findProjectOverride — upward search", () => {
  let tmpRoot: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedCwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedCwd = process.cwd();
    tmpRoot = join(
      tmpdir(),
      `oc-mr-walk-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });
    // Isolate the global layer to an empty home so only the project file matters.
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    invalidateConfigCache();
  });

  function write(path: string, obj: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj), "utf-8");
  }

  it("finds the project file from a nested subdirectory", () => {
    const project = join(tmpRoot, "repo");
    const file = join(project, ".opencode", "opencode-model-router.overrides.jsonc");
    write(file, { defaultTier: "fast" });
    mkdirSync(join(project, ".git"), { recursive: true });
    const deep = join(project, "src", "feature", "deep");
    mkdirSync(deep, { recursive: true });

    process.chdir(deep);
    expect(findProjectOverride()).toBe(realpathSync(file));
  });

  it("does not escape the project root (stops at .git)", () => {
    // An override above the repo root must NOT be picked up.
    write(join(tmpRoot, ".opencode", "opencode-model-router.overrides.jsonc"), {
      defaultTier: "heavy",
    });
    const project = join(tmpRoot, "repo");
    mkdirSync(join(project, ".git"), { recursive: true });
    const sub = join(project, "sub");
    mkdirSync(sub, { recursive: true });

    process.chdir(sub);
    expect(findProjectOverride()).toBeUndefined();
  });

  it("loadConfig applies the project override when launched from a subdir", () => {
    const project = join(tmpRoot, "repo");
    write(join(project, ".opencode", "opencode-model-router.overrides.jsonc"), {
      presets: { anthropic: { fast: { model: "anthropic/from-subdir" } } },
    });
    mkdirSync(join(project, ".git"), { recursive: true });
    const deep = join(project, "a", "b");
    mkdirSync(deep, { recursive: true });

    process.chdir(deep);
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/from-subdir",
    );
  });
});
