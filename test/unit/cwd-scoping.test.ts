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
