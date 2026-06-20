import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVerificationWiring,
  extractAssistantText,
} from "../../src/verify/wiring";
import { newLadderState, buildEscalatePolicy } from "../../src/escalate/ladder";
import type { RouterConfig } from "../../src/router/config";

describe("extractAssistantText", () => {
  it("joins text parts and ignores non-text parts", () => {
    const res = {
      data: { parts: [{ type: "text", text: "a" }, { type: "tool", x: 1 }, { type: "text", text: "b" }] },
    };
    expect(extractAssistantText(res)).toBe("a\nb");
  });

  it("is defensive about missing/garbage shapes", () => {
    expect(extractAssistantText(undefined)).toBe("");
    expect(extractAssistantText({})).toBe("");
    expect(extractAssistantText({ data: { parts: [{ type: "text" }] } })).toBe("");
  });
});

describe("buildGateDeps", () => {
  it("defaults minGraderTier/require when enforcement is absent", () => {
    const wiring = createVerificationWiring({
      client: {},
      directory: "/proj",
      getConfig: () => ({}) as unknown as RouterConfig,
    });
    const deps = wiring.buildGateDeps();
    expect(deps.deterministic.cwd).toBe("/proj");
    expect(deps.checker.ladder).toEqual(["fast", "medium", "heavy"]);
    expect(deps.checker.minGraderTier).toBeNull();
    expect(deps.require).toBeUndefined();
  });

  it("reflects the current config (read fresh each call)", () => {
    let cfg = {
      enforcement: { verify: { minGraderTier: "medium", require: "always" } },
    } as unknown as RouterConfig;
    const wiring = createVerificationWiring({
      client: {},
      directory: "/proj",
      getConfig: () => cfg,
    });
    expect(wiring.buildGateDeps().checker.minGraderTier).toBe("medium");
    expect(wiring.buildGateDeps().require).toBe("always");
    // change config -> next buildGateDeps() picks it up
    cfg = { enforcement: { verify: { require: "never" } } } as unknown as RouterConfig;
    expect(wiring.buildGateDeps().require).toBe("never");
    expect(wiring.buildGateDeps().checker.minGraderTier).toBeNull();
  });
});

describe("exec / fs seams (via buildGateDeps)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-wiring-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function deps() {
    return createVerificationWiring({
      client: {},
      directory: dir,
      getConfig: () => ({}) as unknown as RouterConfig,
    }).buildGateDeps().deterministic;
  }

  it("exec returns code 0 + stdout for a successful command", async () => {
    const r = await deps().exec("echo hello-wiring");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello-wiring");
    expect(r.timedOut).toBe(false);
  });

  it("exec returns a non-zero code for a failing command", async () => {
    const r = await deps().exec("sh -c 'exit 7'");
    expect(r.code).not.toBe(0);
  });

  it("fs.fileExists resolves relative paths against the directory", async () => {
    writeFileSync(join(dir, "f.txt"), "hi", "utf-8");
    expect(await deps().fs.fileExists("f.txt")).toBe(true);
    expect(await deps().fs.fileExists("nope.txt")).toBe(false);
    expect(await deps().fs.readFile("f.txt")).toBe("hi");
  });
});

describe("dispatchGrader + isGraderSession", () => {
  const cfg = {
    activePreset: "p",
    presets: { p: { fast: { model: "p/fast-model" } } },
  } as unknown as RouterConfig;

  it("runs the grader in a fresh session and clears tracking afterward", async () => {
    let trackedDuringPrompt = false;
    // eslint-disable-next-line prefer-const
    let wiringRef: ReturnType<typeof createVerificationWiring>;
    const client = {
      session: {
        create: async () => ({ data: { id: "grader-1" } }),
        prompt: async () => {
          trackedDuringPrompt = wiringRef.isGraderSession("grader-1");
          return { data: { parts: [{ type: "text", text: "VERDICT" }] } };
        },
      },
    };
    wiringRef = createVerificationWiring({ client, directory: ".", getConfig: () => cfg });
    const r = await wiringRef.buildGateDeps().checker.dispatchGrader({
      tier: "fast",
      system: "s",
      prompt: "p",
    });
    expect(r).toEqual({ sessionID: "grader-1", text: "VERDICT" });
    expect(trackedDuringPrompt).toBe(true); // tracked while running
    expect(wiringRef.isGraderSession("grader-1")).toBe(false); // cleared after
  });

  it("returns empty result when no session id comes back", async () => {
    const client = { session: { create: async () => ({ data: {} }), prompt: async () => ({}) } };
    const wiring = createVerificationWiring({ client, directory: ".", getConfig: () => cfg });
    const r = await wiring.buildGateDeps().checker.dispatchGrader({ tier: "fast", system: "", prompt: "" });
    expect(r).toEqual({ sessionID: "", text: "" });
  });
});

describe("dumpDelegateScorecard", () => {
  it("appends a scorecard line to a temp log (best-effort)", () => {
    const wiring = createVerificationWiring({
      client: {},
      directory: ".",
      getConfig: () => ({}) as unknown as RouterConfig,
    });
    const sid = `wiring-test-${process.pid}-${Date.now()}`;
    const state = newLadderState("fast", buildEscalatePolicy({} as unknown as RouterConfig));
    const file = join(tmpdir(), "opencode-model-router-trajectory", `${sid}.delegate.log`);
    try {
      wiring.dumpDelegateScorecard(sid, state, true, "deterministic");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf-8").length).toBeGreaterThan(0);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
