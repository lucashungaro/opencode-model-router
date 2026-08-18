import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { parseAcceptanceBlock } from "../../src/verify/dod";
import { buildDoDProtocolSection } from "../../src/router/protocol";
import { loadConfig, invalidateConfigCache } from "../../src/router/config";

/**
 * Drift guard for the `/annotate-plan` command.
 *
 * The command template (src/index.ts) instructs the model to emit `[acceptance]`
 * blocks, but the parser that consumes them (src/verify/dod.ts) and the protocol
 * section that advertises the same grammar (src/router/protocol.ts) are maintained
 * independently. `parseAcceptanceBlock` silently skips unknown check kinds, so a
 * template that drifts ahead of the parser fails *quietly* — the emitted checks are
 * dropped and the DoD degrades without any error. These tests make that loud.
 */

/**
 * Pull the check kinds a grammar string advertises out of its enumeration line
 * (the single line that lists alternatives separated by `|`).
 *
 * Deliberately tolerant: it keys off the `|` separator and the leading identifier
 * of each alternative, so it survives re-wording, added `path=`/`command=` hints,
 * ASCII-vs-unicode ellipses, and `<...>` wrappers.
 */
function extractAdvertisedKinds(text: string): Set<string> {
  const line = text.split("\n").find((l) => l.includes("|") && /check/i.test(l));
  if (!line) return new Set<string>();
  const afterColon = line.slice(line.indexOf(":") + 1);
  const kinds = afterColon
    .split("|")
    .map((segment) => segment.trim().replace(/^[<([]/, "").trim())
    .map((segment) => (segment.match(/^[A-Za-z][A-Za-z0-9]*/) ?? [""])[0])
    .filter((kind) => kind.length > 0);
  return new Set(kinds);
}

/** Wrap a single `check:` line in a minimal acceptance block. */
function block(checkLine: string): string {
  return ["[acceptance]", checkLine, "[/acceptance]"].join("\n");
}

describe("/annotate-plan template <-> acceptance grammar", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let registered: any;
  let template: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  beforeEach(async () => {
    // Redirect HOME/USERPROFILE so the real state file is never touched.
    testHomeDir = join(tmpdir(), `oc-mr-annotate-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();

    hooks = await ModelRouterPlugin({} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opencodeConfig: any = {};
    await hooks.config(opencodeConfig);
    registered = opencodeConfig.command?.["annotate-plan"];
    template = typeof registered?.template === "string" ? registered.template : "";
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

  // -------------------------------------------------------------------------
  // (a) registration
  // -------------------------------------------------------------------------

  it("registers annotate-plan with a non-empty template and description", () => {
    expect(registered).toBeDefined();
    expect(typeof registered.template).toBe("string");
    expect(registered.template.trim().length).toBeGreaterThan(0);
    expect(typeof registered.description).toBe("string");
    expect(registered.description.trim().length).toBeGreaterThan(0);
    expect(registered.description.toLowerCase()).toContain("tier");
  });

  it("template instructs emitting both tier tags and acceptance blocks", () => {
    expect(template).toContain("[tier:fast]");
    expect(template).toContain("[tier:medium]");
    expect(template).toContain("[tier:heavy]");
    expect(template).toContain("[acceptance]");
    expect(template).toContain("[/acceptance]");
  });

  // -------------------------------------------------------------------------
  // (b) the grammar the template advertises actually parses
  // -------------------------------------------------------------------------

  const CASES: Array<{
    kind: string;
    checkLine: string;
    want: { command?: string; expect?: string; path?: string };
  }> = [
    { kind: "testsPass", checkLine: "check: testsPass", want: {} },
    { kind: "buildPasses", checkLine: "check: buildPasses", want: {} },
    { kind: "lintClean", checkLine: "check: lintClean", want: {} },
    {
      kind: "fileExists",
      checkLine: "check: fileExists path=src/foo.ts",
      want: { path: "src/foo.ts" },
    },
    {
      kind: "run",
      checkLine: 'check: run command="npm test" expect=OK',
      want: { command: "npm test", expect: "OK" },
    },
  ];

  it.each(CASES)("parses a $kind check to the expected kind and fields", ({ kind, checkLine, want }) => {
    const dod = parseAcceptanceBlock(block(checkLine));
    expect(dod).not.toBeNull();
    expect(dod!.checks).toHaveLength(1);

    const check = dod!.checks[0];
    expect(check.kind).toBe(kind);
    if (want.command !== undefined) expect(check.command).toBe(want.command);
    if (want.expect !== undefined) expect(check.expect).toBe(want.expect);
    if (want.path !== undefined) expect(check.path).toBe(want.path);
  });

  it("parses a full acceptance block with criteria and deliverable", () => {
    const dod = parseAcceptanceBlock(
      [
        "[acceptance]",
        "check: testsPass",
        'check: run command="npm run typecheck" expect=OK',
        "criteria: the suite and typecheck both pass",
        "deliverable: src/router/annotate.ts",
        "[/acceptance]",
      ].join("\n"),
    );

    expect(dod).not.toBeNull();
    expect(dod!.checks.map((c) => c.kind)).toEqual(["testsPass", "run"]);
    expect(dod!.criteria).toContain("the suite and typecheck both pass");
    expect(dod!.deliverable).toBe("src/router/annotate.ts");
  });

  // -------------------------------------------------------------------------
  // (c) template <-> parser <-> protocol consistency
  // -------------------------------------------------------------------------

  it("advertises at least one check kind", () => {
    expect(extractAdvertisedKinds(template).size).toBeGreaterThan(0);
  });

  it("every check kind the template advertises is accepted by the parser", () => {
    const advertised = [...extractAdvertisedKinds(template)];

    for (const kind of advertised) {
      // schemaMatch/fileExists need a path; run needs a command. Supply the
      // superset of arguments — the parser keeps only what each kind declares.
      const checkLine = `check: ${kind} path=src/foo.ts schema=s.json command="npm test" expect=OK`;
      const dod = parseAcceptanceBlock(block(checkLine));

      expect(dod, `parser returned null for advertised kind: ${kind}`).not.toBeNull();
      expect(
        dod!.checks.map((c) => c.kind),
        `advertised kind silently dropped by parseAcceptanceBlock: ${kind}`,
      ).toContain(kind);
    }
  });

  it("every check kind the protocol advertises is accepted by the parser", () => {
    const protocolText = buildDoDProtocolSection(loadConfig());
    const advertised = [...extractAdvertisedKinds(protocolText)];

    expect(advertised.length).toBeGreaterThan(0);

    for (const kind of advertised) {
      const checkLine = `check: ${kind} path=src/foo.ts schema=s.json command="npm test" expect=OK`;
      const dod = parseAcceptanceBlock(block(checkLine));

      expect(dod, `parser returned null for advertised kind: ${kind}`).not.toBeNull();
      expect(
        dod!.checks.map((c) => c.kind),
        `advertised kind silently dropped by parseAcceptanceBlock: ${kind}`,
      ).toContain(kind);
    }
  });

  it("template check kinds are a subset of the protocol's", () => {
    const templateKinds = extractAdvertisedKinds(template);
    const protocolKinds = extractAdvertisedKinds(buildDoDProtocolSection(loadConfig()));

    const extra = [...templateKinds].filter((k) => !protocolKinds.has(k));
    expect(extra, `template advertises kinds the protocol does not: ${extra.join(", ")}`).toEqual([]);
  });

  it("documents the known template/protocol gap so a change is noticed", () => {
    const templateKinds = extractAdvertisedKinds(template);
    const protocolKinds = extractAdvertisedKinds(buildDoDProtocolSection(loadConfig()));

    // The annotate-plan template intentionally omits schemaMatch: plan steps rarely
    // assert a JSON schema, and the shorter list keeps the prompt cheap. If this set
    // changes, the omission was either fixed or widened — both worth a deliberate look.
    const onlyInProtocol = [...protocolKinds].filter((k) => !templateKinds.has(k)).sort();
    expect(onlyInProtocol).toEqual(["schemaMatch"]);
  });
});
