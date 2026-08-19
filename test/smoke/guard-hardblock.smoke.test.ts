/**
 * Smoke test: verify the model-router plugin's tool.execute.before hard-block
 * fires inside a real subagent session launched by `opencode run`.
 *
 * Trigger: a benign recon delegation that asks a fast subagent to read 6 files
 * sequentially with the Read tool.  In enforced mode the read_budget guard
 * (readDraftCap=3) fires on the 4th consecutive non-producing read and the
 * forcingMessage always contains "NEXT:".
 *
 * NB: this only fires because the recon dispatch is classified NON-trivial
 * (multi-file, sequenced).  A single-shot lookup is exempted by proportional
 * bypass (GA-6) by design; see classifyTrivial in src/router/sessions.ts.
 *
 * GATED: runs only when RUN_OC_SMOKE=1 is set AND the suite is invoked
 * explicitly (e.g. `npx vitest run test/smoke/guard-hardblock.smoke.test.ts`).
 * Excluded from default `npm test` by vitest.config.ts exclude pattern.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RUN = process.env.RUN_OC_SMOKE === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "tmp", "smoke");
const OUT_FILE = path.join(OUT_DIR, "guard-hardblock.json");

/**
 * Model used for the live `opencode run` call.
 *
 * Defaults to the Anthropic model this lane was originally proven against.
 * Set MODEL_ROUTER_SMOKE_MODEL to run the lane on another provider (e.g.
 * `opencode-go/qwen3.7-plus` when only an OpenCode Zen key is available).
 * With the env var unset, behaviour is byte-identical to the original.
 */
const SMOKE_MODEL_ENV = process.env.MODEL_ROUTER_SMOKE_MODEL;
/**
 * An EMPTY value counts as unset.  A GitHub Actions `env:` entry bound to an
 * expression that resolves to nothing still exports the variable as "", and a
 * bare `?? ` would then hand `--model ""` to the CLI.
 */
const MODEL_OVERRIDDEN = SMOKE_MODEL_ENV != null && SMOKE_MODEL_ENV !== "";
const SMOKE_MODEL = MODEL_OVERRIDDEN
  ? SMOKE_MODEL_ENV
  : "anthropic/claude-haiku-4-5";

/**
 * Project-level router overrides file.  `.opencode/` is gitignored.
 *
 * `--model` only selects the ORCHESTRATOR model; the subagent that this test
 * actually asserts on is registered by the plugin from the active preset's
 * tier config, so it stays on Anthropic unless the tiers are overridden too.
 * This file is how we move the tiers without touching tiers.json (#22).
 */
const OVERRIDES_DIR = path.join(REPO_ROOT, ".opencode");
const OVERRIDES_FILE = path.join(
  OVERRIDES_DIR,
  "opencode-model-router.overrides.jsonc"
);

/**
 * Point every tier of the ACTIVE preset at SMOKE_MODEL.
 *
 * Returns a restore function that is safe to call unconditionally.  When
 * MODEL_ROUTER_SMOKE_MODEL is unset this writes NOTHING and touches NOTHING,
 * so the Anthropic path is completely unaffected.
 *
 * `variant: ""` matters: the bundled anthropic preset sets `variant: "max"` on
 * medium/heavy, the loader deep-merges (siblings survive, keys cannot be
 * deleted), and src/index.ts applies `variant` with a truthiness check — so an
 * empty string is the only way to stop an Anthropic-only knob from riding
 * along to a non-Anthropic model.
 */
function installTierOverrides(): () => void {
  if (!MODEL_OVERRIDDEN) return () => {};

  const tiers = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "tiers.json"), "utf8")
  ) as { activePreset?: string };
  const preset = tiers.activePreset ?? "anthropic";

  fs.mkdirSync(OVERRIDES_DIR, { recursive: true });
  const previous = fs.existsSync(OVERRIDES_FILE)
    ? fs.readFileSync(OVERRIDES_FILE, "utf8")
    : null;

  const tierOverride = { model: SMOKE_MODEL, variant: "" };
  fs.writeFileSync(
    OVERRIDES_FILE,
    JSON.stringify(
      {
        presets: {
          [preset]: {
            fast: tierOverride,
            medium: tierOverride,
            heavy: tierOverride,
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );

  return () => {
    if (previous !== null) {
      fs.writeFileSync(OVERRIDES_FILE, previous, "utf8");
    } else {
      try {
        fs.unlinkSync(OVERRIDES_FILE);
      } catch {
        // Already absent or removed by a parallel process — ignore.
      }
    }
  };
}

/**
 * Assert the SUBAGENT really ran on SMOKE_MODEL.
 *
 * The task tool echoes the resolved subagent model back as
 * `"model":{"providerID":"...","modelID":"..."}`.  Without this check a green
 * run proves nothing about the override: the orchestrator would be on the Go
 * model while the guard-firing subagent quietly stayed on Anthropic.
 */
function assertSubagentModel(stdout: string): void {
  const slash = SMOKE_MODEL.indexOf("/");
  const providerID = SMOKE_MODEL.slice(0, slash);
  const modelID = SMOKE_MODEL.slice(slash + 1);
  // Tolerate both compact and spaced JSON serialisations.
  const pattern = new RegExp(
    `"providerID"\\s*:\\s*"${providerID}"\\s*,\\s*"modelID"\\s*:\\s*"${modelID}"`
  );
  if (!pattern.test(stdout)) {
    const seen = [
      ...new Set(
        stdout.match(/"providerID"\s*:\s*"[^"]*"\s*,\s*"modelID"\s*:\s*"[^"]*"/g) ??
          []
      ),
    ];
    throw new Error(
      `Subagent did NOT run on ${SMOKE_MODEL}. The tier override did not take ` +
        `effect, so this run does not validate the ${providerID} provider.\n` +
        `provider/model pairs observed in output: ${JSON.stringify(seen)}`
    );
  }
  console.log(`Subagent model confirmed: ${SMOKE_MODEL}`);
}

/** Run `opencode run` with enforcement forced on and capture the JSON stream. */
function runEnforced(prompt: string, outFile: string) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const start = Date.now();

  const result = spawnSync(
    "opencode",
    [
      "run",
      prompt,
      "--model",
      SMOKE_MODEL,
      "--format",
      "json",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_ROUTER_ENFORCE: "1" },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180_000,
    }
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`opencode exited in ${elapsed}s, status=${result.status}`);

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { exitCode: result.status, elapsed, stdout, stderr: stderr.slice(0, 4000) },
      null,
      2
    )
  );

  if (result.status !== 0) {
    const excerpt = (stdout + "\n" + stderr).slice(0, 600);
    throw new Error(
      `opencode exited with code ${result.status}.\nExcerpt:\n${excerpt}`
    );
  }

  return { stdout, outFile };
}

// Benign recon prompt: asks a fast subagent to read 6 files one-at-a-time.
// readDraftCap=3 means after 3 consecutive reads (non-producing actions),
// the 4th read is blocked; the forcingMessage always contains "NEXT:" and
// the read_budget observation contains "read/draft".
const PROMPT =
  'Use Task(subagent_type="fast", description="recon", prompt="Read these files ONE AT A TIME using the read tool, in this exact order, and after each give a one-line summary: README.md, then package.json, then tsconfig.json, then tiers.json, then LICENSE, then src/index.ts. Use the read tool separately for each file; do not skip any."). After the subagent returns, reply with the single word DONE.';

// Stable substrings sourced directly from guards.ts:
//   forcingMessage  → always "NEXT:"
//   read_budget obs → "read/draft budget exhausted"
//   redundant_read  → "redundant" (guard name / fp string)
// Additional lenient markers (model paraphrases when inner session events
// are not forwarded to outer stream):
//   "read budget"   → model says "I've exhausted my read budget" when blocked
const MARKERS = ["NEXT:", "read/draft", "budget exhausted", "redundant", "read budget"];

// The opposite arm — a genuinely trivial dispatch must NOT be hard-blocked —
// is asserted deterministically in test/integration/proportional-downgrade.test.ts
// rather than here. A real-session trivial arm cannot be made reliable on this
// host: subagent prompts arrive with a `Working directory:` footer naming a
// directory that does not exist (not emitted by this plugin), so whether the
// subagent completes a one-file lookup or bails depends on whether the model
// honours that footer. Absence of guard markers from a subagent that never ran
// the read proves nothing, so the arm would pass vacuously.

d("guard hard-block smoke", () => {
  it(
    "read_budget guard fires inside a subagent session (benign recon trigger)",
    () => {
      // No-op (and writes nothing) on the default Anthropic path.
      const restoreOverrides = installTierOverrides();
      let stdout: string;
      try {
        ({ stdout } = runEnforced(PROMPT, OUT_FILE));
      } finally {
        restoreOverrides();
      }

      // At least one read-guard marker must appear (case-insensitive)
      const lower = stdout.toLowerCase();
      const found = MARKERS.filter((m) => lower.includes(m.toLowerCase()));

      if (found.length === 0) {
        const excerpt = stdout.slice(0, 600);
        throw new Error(
          `Read-guard DID NOT fire: none of [${MARKERS.join(", ")}] found in output.\n` +
            `Output excerpt (600 chars):\n${excerpt}`
        );
      }

      console.log(`Read-guard markers found: ${JSON.stringify(found)}`);

      // ADDITIONAL check (never weakens the above): when a model override is
      // requested, prove the subagent honoured it rather than silently
      // falling back to the bundled Anthropic tier.
      if (MODEL_OVERRIDDEN) {
        assertSubagentModel(stdout);
      }

      console.log(`Evidence written to: ${OUT_FILE}`);
    },
    185_000
  );

});
