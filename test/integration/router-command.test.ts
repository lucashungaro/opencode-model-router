import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import { loadConfig, invalidateConfigCache } from "../../src/router/config";

describe("router-command integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  beforeEach(async () => {
    // Redirect HOME/USERPROFILE so the real state file is never touched.
    testHomeDir = join(tmpdir(), `oc-mr-router-cmd-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();
    hooks = await ModelRouterPlugin({} as any);
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    invalidateConfigCache();
  });

  it("enforce enforced persists + reload", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, out);
    expect(out.parts[0].text).toContain("enforced");
    expect(out.parts[0].text).toContain("persisted");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("enforced");
  });

  it("enforce off persists", async () => {
    // Prime to enforced first so "off" is a meaningful state transition.
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, { parts: [] as any[] });
    invalidateConfigCache();

    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce off" }, out);
    expect(out.parts[0].text).toContain("off");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("off");
  });

  it("enforce with no mode shows current + usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce" }, out);
    expect(out.parts[0].text).toContain("Usage:");
    expect(out.parts[0].text).toContain("Current enforcement mode");
  });

  it("invalid mode shows usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce loud" }, out);
    expect(out.parts[0].text).toContain("Usage:");
  });

  it("bare /router shows status", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, out);
    expect(out.parts[0].text).toContain("Enforcement:");
    expect(out.parts[0].text).toContain("/router overrides");
  });

  it("overrides shows both layer paths + precedence", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "overrides" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("config overrides");
    expect(text).toContain("opencode-model-router.overrides.jsonc"); // global path
    expect(text).toContain(".opencode"); // project path
    expect(text).toContain("Active preset");
  });
  // A preset defined in an overrides file may carry only `model` per tier. The
  // /tiers renderer used to assume description/whenToUse were always present, so
  // a minimal preset crashed the command on `tier.whenToUse.join(...)`.
  it("renders a model-only override preset without crashing", async () => {
    const overrides = join(
      testHomeDir,
      ".config/opencode/opencode-model-router.overrides.jsonc",
    );
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(
      overrides,
      JSON.stringify({
        presets: { local: { fast: { model: "local/qwen3" } } },
        activePreset: "local",
      }),
      "utf-8",
    );
    invalidateConfigCache();
    hooks = await ModelRouterPlugin({} as any);

    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "tiers", arguments: "" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("local/qwen3");
    expect(text).not.toContain("undefined");
  });
});

describe("router-command — model catalog", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  // Mock opencode client exposing config.providers(). Only anthropic is
  // configured and it carries a single model, so the default anthropic preset
  // (which also names sonnet and opus) surfaces missing-model issues.
  const ctx = {
    directory: ".",
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "anthropic",
                name: "Anthropic",
                models: {
                  "claude-haiku-4-5": { id: "claude-haiku-4-5", status: "active" },
                },
              },
            ],
            default: { anthropic: "claude-haiku-4-5" },
          },
        }),
      },
    },
  };

  beforeEach(async () => {
    testHomeDir = join(tmpdir(), `oc-mr-catalog-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();
    hooks = await ModelRouterPlugin(ctx as any);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    invalidateConfigCache();
  });

  it("/router models lists configured providers and model ids", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "models" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("available models");
    expect(text).toContain("anthropic");
    expect(text).toContain("anthropic/claude-haiku-4-5");
  });

  it("/router models <provider> with no match explains what is available", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "models openai" }, out);
    expect(out.parts[0].text).toContain("No configured provider matches");
  });

  it("bare /router appends model issues for the active preset", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("Model issues in the active preset");
    // suggests the one model the catalog does have
    expect(text).toContain("anthropic/claude-haiku-4-5");
  });

  // A failed or unavailable fetch must degrade to a message, not an exception.
  it("reports the catalog as unavailable when the provider call throws", async () => {
    invalidateConfigCache();
    const failing: any = {
      directory: ".",
      client: { config: { providers: async () => { throw new Error("not ready"); } } },
    };
    const h: any = await ModelRouterPlugin(failing);
    const out = { parts: [] as any[] };
    await h["command.execute.before"]({ command: "router", arguments: "models" }, out);
    expect(out.parts[0].text).toContain("Model catalog unavailable");
  });
});
