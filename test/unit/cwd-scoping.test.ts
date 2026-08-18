// test/unit/cwd-scoping.test.ts
// Layer-2 verification must resolve file paths against the producer subagent's
// working directory (delegation.cwd), defaulting to the router's own directory
// when omitted (byte-identical to prior behavior).
//
// Cross-platform note: every expectation is built with node:path helpers so the
// suite is green on both ubuntu and windows. Separator-sensitive cases
// (drive letters, UNC) branch on process.platform instead of hardcoding "/".

import { describe, it, expect } from "vitest";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBaseDir, resolveAgainst } from "../../src/verify/paths";
import { runDeterministic } from "../../src/verify/deterministic";
import { runChecker, buildGradingPrompt } from "../../src/verify/checker";
import type { CheckerDeps, CheckerInput, GraderRequest } from "../../src/verify/checker";
import type { DeterministicDeps } from "../../src/verify/types";
import type { DoD } from "../../src/verify/dod";

const isWin = process.platform === "win32";

// ---------------------------------------------------------------------------
// resolveBaseDir — the three branches
// ---------------------------------------------------------------------------

describe("resolveBaseDir", () => {
  const routerDir = join(tmpdir(), "router-home");

  it("returns the router directory when cwd is undefined", () => {
    expect(resolveBaseDir(undefined, routerDir)).toBe(routerDir);
  });

  it("returns the router directory when cwd is empty (falsy)", () => {
    expect(resolveBaseDir("", routerDir)).toBe(routerDir);
  });

  // Documented behavior, not an aspiration: the falsy guard is `!cwd`, so a
  // whitespace-only cwd is TRUTHY and is treated as an ordinary relative path.
  // It is therefore joined onto the router dir rather than falling back to it.
  // Callers that want a blank-ish cwd ignored must trim before calling.
  it("treats a whitespace-only cwd as a relative path (joined, NOT a fallback)", () => {
    expect(resolveBaseDir("   ", routerDir)).toBe(join(routerDir, "   "));
  });

  it("returns an absolute cwd unchanged", () => {
    const abs = join(tmpdir(), "external-work");
    expect(isAbsolute(abs)).toBe(true);
    expect(resolveBaseDir(abs, routerDir)).toBe(abs);
  });

  it("joins a relative cwd onto the router directory", () => {
    expect(resolveBaseDir(join("sub", "work"), routerDir)).toBe(join(routerDir, "sub", "work"));
  });
});

// ---------------------------------------------------------------------------
// resolveAgainst
// ---------------------------------------------------------------------------

describe("resolveAgainst", () => {
  const base = join(tmpdir(), "base");

  it("joins relative paths onto the base dir", () => {
    expect(resolveAgainst(base, "out.txt")).toBe(join(base, "out.txt"));
  });

  it("returns absolute paths unchanged", () => {
    const abs = join(tmpdir(), "abs.txt");
    expect(resolveAgainst(base, abs)).toBe(abs);
  });

  // POSIX-rooted paths are absolute under BOTH path.win32 and path.posix, so
  // this assertion holds on every platform.
  it("leaves a posix-rooted absolute path untouched", () => {
    const posixAbs = join("/", "x", "y");
    expect(isAbsolute(posixAbs)).toBe(true);
    expect(resolveAgainst(base, posixAbs)).toBe(posixAbs);
  });

  it.runIf(isWin)("leaves a windows drive-letter absolute path untouched", () => {
    const driveAbs = "C:\\x\\y";
    expect(isAbsolute(driveAbs)).toBe(true);
    expect(resolveAgainst(base, driveAbs)).toBe(driveAbs);
  });

  // On posix a drive-letter string is not absolute; it is an ordinary relative
  // segment and gets joined. Asserted so the platform split is explicit rather
  // than silently skipped.
  it.skipIf(isWin)("treats a windows drive-letter path as relative on posix", () => {
    const driveAbs = "C:\\x\\y";
    expect(isAbsolute(driveAbs)).toBe(false);
    expect(resolveAgainst(base, driveAbs)).toBe(join(base, driveAbs));
  });

  it.runIf(isWin)("does not mangle a UNC path", () => {
    const unc = "\\\\server\\share\\x";
    expect(isAbsolute(unc)).toBe(true);
    expect(resolveAgainst(base, unc)).toBe(unc);
  });

  it("round-trips a path containing spaces", () => {
    const spaced = join("my dir", "my out.txt");
    expect(resolveAgainst(base, spaced)).toBe(join(base, "my dir", "my out.txt"));
  });

  // Intended behavior: an empty path is not absolute, so it is join(base, "")
  // -- node drops empty segments, which normalizes to the base dir itself.
  // A check with an empty path therefore targets the base dir, not "".
  it('returns the base dir for an empty path (intended: join(base, ""))', () => {
    expect(resolveAgainst(base, "")).toBe(join(base, ""));
    expect(resolveAgainst(base, "")).toBe(base);
  });

  // Intended behavior: join normalizes, so "../x" escapes baseDir BY DESIGN.
  // resolveAgainst is path math, not a sandbox -- the threat model here is
  // cooperative producers, and containment is not a property this helper
  // claims. A caller needing containment must check the result separately.
  it("lets a '..' segment escape the base dir by design (join normalizes)", () => {
    const escaped = resolveAgainst(base, join("..", "x"));
    expect(escaped).toBe(join(base, "..", "x"));
    expect(escaped.startsWith(base)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDeterministic honors deps.cwd (effective base dir)
// ---------------------------------------------------------------------------

function fileExistsDoD(path = "out.txt"): DoD {
  return {
    kind: "deterministic",
    checks: [{ kind: "fileExists", path }],
    criteria: [],
    deliverable: null,
    source: "explicit",
  };
}

function schemaMatchDoD(path: string, schema: string): DoD {
  return {
    kind: "deterministic",
    checks: [{ kind: "schemaMatch", path, schema }],
    criteria: [],
    deliverable: null,
    source: "explicit",
  };
}

describe("runDeterministic — external cwd resolution", () => {
  it("resolves a relative fileExists path against deps.cwd (external dir) and passes", async () => {
    const externalCwd = join(tmpdir(), "producer-ext");
    let seenPath = "";
    const deps: DeterministicDeps = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      fs: {
        fileExists: async (p) => {
          seenPath = p;
          // File lives under the external cwd, NOT the router's own dir.
          return p.startsWith(externalCwd);
        },
        readFile: async () => "{}",
      },
      cwd: externalCwd,
    };
    const verdict = await runDeterministic(fileExistsDoD("out.txt"), deps);
    expect(verdict.pass).toBe(true);
    expect(seenPath).toBe(join(externalCwd, "out.txt"));
  });

  it("leaves an absolute fileExists path unscoped by deps.cwd", async () => {
    const externalCwd = join(tmpdir(), "producer-ext");
    const abs = join(tmpdir(), "elsewhere", "out.txt");
    let seenPath = "";
    const deps: DeterministicDeps = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      fs: {
        fileExists: async (p) => {
          seenPath = p;
          return true;
        },
        readFile: async () => "{}",
      },
      cwd: externalCwd,
    };
    const verdict = await runDeterministic(fileExistsDoD(abs), deps);
    expect(verdict.pass).toBe(true);
    expect(seenPath).toBe(abs);
  });

  it("emits an honest, cwd-scoped reason when the file is missing", async () => {
    const externalCwd = join(tmpdir(), "producer-ext");
    const deps: DeterministicDeps = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      fs: { fileExists: async () => false, readFile: async () => "{}" },
      cwd: externalCwd,
    };
    const verdict = await runDeterministic(fileExistsDoD("out.txt"), deps);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("file not found");
    expect(verdict.reasons[0]).toContain(externalCwd);
  });

  it("resolves BOTH schemaMatch paths (target + schema file) against deps.cwd", async () => {
    const externalCwd = join(tmpdir(), "producer-ext");
    const seen: string[] = [];
    const target = JSON.stringify({ name: "foo" });
    const schema = JSON.stringify({ name: "" });
    const deps: DeterministicDeps = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      fs: {
        fileExists: async () => true,
        readFile: async (p) => {
          seen.push(p);
          return p.endsWith("target.json") ? target : schema;
        },
      },
      cwd: externalCwd,
    };
    const verdict = await runDeterministic(schemaMatchDoD("target.json", "schema.json"), deps);
    expect(verdict.pass).toBe(true);
    expect(seen).toEqual([join(externalCwd, "target.json"), join(externalCwd, "schema.json")]);
  });

  it("does not resolve an inline schema literal as a path", async () => {
    const externalCwd = join(tmpdir(), "producer-ext");
    const seen: string[] = [];
    const deps: DeterministicDeps = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      fs: {
        fileExists: async () => true,
        readFile: async (p) => {
          seen.push(p);
          return JSON.stringify({ name: "bar" });
        },
      },
      cwd: externalCwd,
    };
    const verdict = await runDeterministic(
      schemaMatchDoD("target.json", JSON.stringify({ name: "" })),
      deps,
    );
    expect(verdict.pass).toBe(true);
    expect(seen).toEqual([join(externalCwd, "target.json")]);
  });
});

// ---------------------------------------------------------------------------
// checker forwards the producer working directory to the grader
// ---------------------------------------------------------------------------

function checkerInput(workingDir?: string): CheckerInput {
  return {
    criteria: ["ships a thing"],
    artefact: { finalReturnText: "done", changedFiles: [], declaredOutputs: [] },
    producerTier: "fast",
    producerSessionID: "producer-sess",
    ...(workingDir ? { workingDir } : {}),
  };
}

describe("runChecker — workingDir forwarding", () => {
  function capturingDeps(seen: GraderRequest[]): CheckerDeps {
    return {
      dispatchGrader: async (req) => {
        seen.push(req);
        return { sessionID: "grader-sess", text: JSON.stringify({ pass: true, reasons: [] }) };
      },
      ladder: ["fast", "medium", "heavy"],
    };
  }

  it("forwards workingDir as GraderRequest.cwd when set", async () => {
    const producerDir = join(tmpdir(), "producer-ext");
    const seen: GraderRequest[] = [];
    const verdict = await runChecker(checkerInput(producerDir), capturingDeps(seen));
    expect(verdict.pass).toBe(true);
    expect(seen[0]?.cwd).toBe(producerDir);
  });

  it("omits cwd entirely when workingDir is absent (byte-identical request)", async () => {
    const seen: GraderRequest[] = [];
    const verdict = await runChecker(checkerInput(), capturingDeps(seen));
    expect(verdict.pass).toBe(true);
    expect(seen[0] && "cwd" in seen[0]).toBe(false);
  });
});

describe("buildGradingPrompt — working-directory line", () => {
  it("prepends the producer working directory when set", () => {
    const producerDir = join(tmpdir(), "producer-ext");
    const { prompt } = buildGradingPrompt(checkerInput(producerDir));
    expect(prompt.startsWith(`Producer working directory: ${producerDir}.`)).toBe(true);
    expect(prompt).toContain("not your own session directory");
  });

  it("emits a byte-identical prompt when workingDir is absent", () => {
    const { prompt } = buildGradingPrompt(checkerInput());
    expect(prompt.startsWith("## Acceptance criteria")).toBe(true);
    expect(prompt).not.toContain("Producer working directory");
  });
});
