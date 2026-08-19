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

describe("validateEnforcement — shipped keys are type-checked", () => {
  /** The shipped config with one enforcement path replaced by a bad value. */
  function withBadValue(
    section: string | null,
    key: string,
    value: unknown,
  ): Record<string, unknown> {
    const raw = JSON.parse(JSON.stringify(readTiersRaw())) as Record<
      string,
      unknown
    >;
    const enf = raw.enforcement as Record<string, unknown>;
    if (section === null) {
      enf[key] = value;
    } else {
      (enf[section] as Record<string, unknown>)[key] = value;
    }
    return raw;
  }

  const cases: [string | null, string, unknown, RegExp][] = [
    [null, "envGate", "", /enforcement\.envGate must be a non-empty string/],
    [null, "envGate", 1, /enforcement\.envGate must be a non-empty string/],
    [
      "guard",
      "readDraftCap",
      "3",
      /enforcement\.guard\.readDraftCap must be an integer >= 0/,
    ],
    [
      "guard",
      "readDraftCap",
      1.5,
      /enforcement\.guard\.readDraftCap must be an integer >= 0/,
    ],
    [
      "guard",
      "readDraftCap",
      -1,
      /enforcement\.guard\.readDraftCap must be an integer >= 0/,
    ],
    [
      "guard",
      "sameOpRetryCap",
      null,
      /enforcement\.guard\.sameOpRetryCap must be an integer >= 0/,
    ],
    [
      "guard",
      "blockSelfScript",
      "true",
      /enforcement\.guard\.blockSelfScript must be a boolean/,
    ],
    [
      "guard",
      "deliverableFirst",
      0,
      /enforcement\.guard\.deliverableFirst must be a boolean/,
    ],
    [
      "verify",
      "minGraderTier",
      7,
      /enforcement\.verify\.minGraderTier must be a string or null/,
    ],
    [
      "verify",
      "graderTemperature",
      "0",
      /enforcement\.verify\.graderTemperature must be a number >= 0/,
    ],
    [
      "verify",
      "graderTemperature",
      -1,
      /enforcement\.verify\.graderTemperature must be a number >= 0/,
    ],
    [
      "verify",
      "requireExplicitDoD",
      "no",
      /enforcement\.verify\.requireExplicitDoD must be a boolean/,
    ],
    [
      "proportional",
      "trivialBypass",
      "yes",
      /enforcement\.proportional\.trivialBypass must be a boolean/,
    ],
  ];

  for (const [section, key, value, message] of cases) {
    const path = section === null ? key : `${section}.${key}`;
    it(`rejects ${path} = ${JSON.stringify(value)} naming the field`, () => {
      expect(() => validateConfig(withBadValue(section, key, value))).toThrow(
        message,
      );
    });
  }

  it("still accepts every value the shipped block actually uses", () => {
    // Valid-but-different values must not be rejected by the new checks.
    expect(() => validateConfig(withBadValue("guard", "readDraftCap", 0))).not.toThrow();
    expect(() =>
      validateConfig(withBadValue("verify", "minGraderTier", "medium")),
    ).not.toThrow();
    expect(() =>
      validateConfig(withBadValue("verify", "graderTemperature", 0.7)),
    ).not.toThrow();
    expect(() =>
      validateConfig(withBadValue("proportional", "trivialBypass", false)),
    ).not.toThrow();
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
