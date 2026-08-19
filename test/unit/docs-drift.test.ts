import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Documentation-drift guards.
 *
 * These assert that two things the docs claim stay true of the shipped code:
 * every top-level key of `tiers.json` is described in the config reference, and
 * the README quotes the prompt sizes that the golden snapshots actually produce.
 *
 * Both fail on ADDITION, which is the point. Adding a config key or growing the
 * protocol should force the corresponding doc edit in the same change, rather
 * than leaving the docs to rot until someone notices.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf-8");

describe("docs drift", () => {
  it("documents every tiers.json top-level key in CONFIG_REFERENCE.md", () => {
    const tiers = JSON.parse(read("tiers.json")) as Record<string, unknown>;
    const doc = read("docs/CONFIG_REFERENCE.md");

    const keys = Object.keys(tiers);
    // Sanity: a tiers.json that parsed to nothing would make this vacuously green.
    expect(keys.length).toBeGreaterThan(0);

    const undocumented = keys.filter((key) => !doc.includes(`\`${key}\``));
    expect(undocumented).toEqual([]);
  });

  it("quotes the measured prompt figures in README.md", () => {
    const readme = read("README.md");

    // Measured from test/golden/__snapshots__/ with the bundled anthropic preset
    // in normal mode (the shipped activePreset/activeMode defaults):
    //   base protocol                3,089
    //   + Claude authority prefix    3,861
    //   + DoD/enforcement section    4,659
    // Formatted with a thousands separator, as the README writes them.
    const figures = ["3,089", "3,861", "4,659"];

    const missing = figures.filter((figure) => !readme.includes(figure));
    expect(missing).toEqual([]);
  });
});
