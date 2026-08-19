// ---------------------------------------------------------------------------
// Phase 3B — the shipped `enforcement` block in tiers.json must be a pure
// documentation change: every value it pins has to equal the effective default
// the code already applies when the key is absent. These tests resolve the real
// policies twice — once from the shipped tiers.json, once from the same config
// with `enforcement` deleted — and require the results to be identical.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateConfig, type RouterConfig } from "../../src/router/config";
import { buildGuardPolicy } from "../../src/guard/enforce";
import { buildEscalatePolicy } from "../../src/escalate/ladder";
import {
  resolveEnforcementMode,
  DEFAULT_ENV_GATE,
} from "../../src/router/enforcement";
import { buildDoDProtocolSection } from "../../src/router/protocol";

const TIERS_PATH = join(__dirname, "..", "..", "tiers.json");

function readTiersRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(TIERS_PATH, "utf-8")) as Record<
    string,
    unknown
  >;
}

/** The shipped config, and the same config with `enforcement` removed. */
function bothConfigs(): { shipped: RouterConfig; absent: RouterConfig } {
  const raw = readTiersRaw();
  const stripped = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  delete stripped.enforcement;
  return { shipped: validateConfig(raw), absent: validateConfig(stripped) };
}

const TIERS = [null, "fast", "medium", "heavy"] as const;

describe("tiers.json enforcement block — shape", () => {
  it("passes validateConfig as shipped", () => {
    expect(() => validateConfig(readTiersRaw())).not.toThrow();
  });

  it("ships an enforcement block (guards against silent removal)", () => {
    const raw = readTiersRaw();
    expect(raw.enforcement).toBeTypeOf("object");
    expect(raw.enforcement).not.toBeNull();
  });

  it("does not change the active preset", () => {
    expect(readTiersRaw().activePreset).toBe("anthropic");
  });

  it("ships only keys the code actually reads", () => {
    const enf = readTiersRaw().enforcement as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(enf).sort()).toEqual([
      "envGate",
      "escalate",
      "guard",
      "mode",
      "proportional",
      "verify",
    ]);
    // Validated but never read — shipping them would document nothing.
    expect(enf.verify).not.toHaveProperty("require");
    expect(enf.verify).not.toHaveProperty("graderPolicy");
    expect(enf.verify).not.toHaveProperty("preferDeterministic");
    expect(enf.proportional).not.toHaveProperty("trivialClassifier");
    expect(enf.escalate.costCeiling).not.toHaveProperty("base");
  });
});

describe("tiers.json enforcement block — behaviour invariance", () => {
  it("resolves the same guard policy with and without the block", () => {
    const { shipped, absent } = bothConfigs();
    for (const tier of TIERS) {
      expect(buildGuardPolicy(shipped, tier)).toEqual(
        buildGuardPolicy(absent, tier),
      );
    }
  });

  it("resolves the same escalate policy with and without the block", () => {
    const { shipped, absent } = bothConfigs();
    expect(buildEscalatePolicy(shipped)).toEqual(buildEscalatePolicy(absent));
  });

  it("resolves the same enforcement mode with and without the block", () => {
    const { shipped, absent } = bothConfigs();
    const envs: Record<string, string | undefined>[] = [
      {},
      { [DEFAULT_ENV_GATE]: "1" },
      { [DEFAULT_ENV_GATE]: "0" },
      { [DEFAULT_ENV_GATE]: "yes" },
    ];
    for (const env of envs) {
      for (const tier of TIERS) {
        expect(
          resolveEnforcementMode({
            config: shipped,
            tier: tier ?? undefined,
            env,
          }),
        ).toEqual(
          resolveEnforcementMode({
            config: absent,
            tier: tier ?? undefined,
            env,
          }),
        );
      }
    }
  });

  it("pins the same env gate name the code defaults to", () => {
    const enf = readTiersRaw().enforcement as Record<string, unknown>;
    expect(enf.envGate).toBe(DEFAULT_ENV_GATE);
  });

  it("builds the same DoD protocol section with and without the block", () => {
    const { shipped, absent } = bothConfigs();
    expect(buildDoDProtocolSection(shipped)).toBe(
      buildDoDProtocolSection(absent),
    );
  });

  it("resolves the same verify defaults with and without the block", () => {
    const { shipped, absent } = bothConfigs();
    // src/verify/wiring.ts: `cfg.enforcement?.verify?.minGraderTier ?? null`
    expect(shipped.enforcement?.verify?.minGraderTier ?? null).toBe(
      absent.enforcement?.verify?.minGraderTier ?? null,
    );
    // src/index.ts: `cfg.enforcement?.verify?.graderTemperature ?? 0`
    expect(shipped.enforcement?.verify?.graderTemperature ?? 0).toBe(
      absent.enforcement?.verify?.graderTemperature ?? 0,
    );
  });

  it("resolves the same proportional trivial-bypass gate with and without the block", () => {
    const { shipped, absent } = bothConfigs();
    // src/guard/enforce.ts: `cfg.enforcement?.proportional?.trivialBypass !== false`
    expect(shipped.enforcement?.proportional?.trivialBypass !== false).toBe(
      absent.enforcement?.proportional?.trivialBypass !== false,
    );
  });
});
