import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc";

/**
 * Filename of the optional user overrides file (global and project copies share
 * it). `.jsonc` so comments and trailing commas are allowed; mirrors the
 * `opencode-model-router.*` prefix of the state file.
 */
export const OVERRIDE_FILENAME = "opencode-model-router.overrides.jsonc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThinkingConfig {
  budgetTokens?: number;
}

export interface ReasoningConfig {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "always" | "never";
}

export interface TierConfig {
  model: string;
  variant?: string;
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  costRatio?: number;
  color?: string;
  description: string;
  steps?: number;
  prompt?: string;
  whenToUse: string[];
}

export type Preset = Record<string, TierConfig>;

export interface FallbackConfig {
  global?: Record<string, string[]>;
  presets?: Record<string, Record<string, string[]>>;
}

export interface ModeConfig {
  defaultTier: string;
  description: string;
  overrideRules?: string[];
}

export interface EnforcementConfig {
  mode?: "off" | "advisory" | "enforced";
  envGate?: string;
  perTier?: Record<string, "off" | "advisory" | "enforced">;
  guard?: { readDraftCap?: number; sameOpRetryCap?: number; blockSelfScript?: boolean; deliverableFirst?: boolean; budget?: number; blockScriptWrites?: boolean };
  verify?: { require?: "never" | "whenDoDPresent" | "always"; requireExplicitDoD?: boolean; preferDeterministic?: boolean; graderPolicy?: "atLeastProducerTier"; graderTemperature?: number; minGraderTier?: string };
  escalate?: { floorTier?: string | null; ladder?: string[]; maxAttemptsPerTier?: number; maxTotalAttempts?: number; costCeiling?: { base?: string; multiple?: number } };
  proportional?: { trivialBypass?: boolean; trivialClassifier?: string };
}

export interface RouterConfig {
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  fallback?: FallbackConfig;
  taskPatterns?: Record<string, string[]>;
  modes?: Record<string, ModeConfig>;
  /** Global default prompts per tier name. A preset-level tier.prompt overrides this. */
  tierPrompts?: Record<string, string>;
  /** Read-only tool-call caps per tier, enforced at runtime via tool.execute.after banner injection. */
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
  /** Experimental, opt-in features. Off by default. */
  experimental?: { verifiedDelegateTool?: boolean };
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
}

// ---------------------------------------------------------------------------
// Config loader with caching
// ---------------------------------------------------------------------------

let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

/** Mark config cache as stale so it is re-read on next access. */
export function invalidateConfigCache(): void {
  _configDirty = true;
}

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "../.."); // src/router/ -> plugin root
}

function configPath(): string {
  return join(getPluginRoot(), "tiers.json");
}

/**
 * Path to the global user overrides file. Lives in the stable opencode config
 * dir (next to the state file) so it survives plugin updates — unlike the
 * bundled tiers.json, which sits in the cache dir and is overwritten on every
 * update. Anything here is deep-merged over the bundled config.
 */
export function overridePath(): string {
  return join(homedir(), ".config", "opencode", OVERRIDE_FILENAME);
}

/**
 * Default location of the project-local overrides file
 * (`.opencode/opencode-model-router.overrides.jsonc` in the current working
 * directory). This is the path to *create* the file at; the actual lookup walks
 * upward — see {@link findProjectOverride}. Used for display when no project
 * file is found.
 *
 * The project file is deep-merged *after* (and therefore wins over) the global
 * overrides file, so a team can commit a shared file that unifies routing for
 * the project on top of each member's personal global file.
 */
export function localOverridePath(): string {
  return join(process.cwd(), ".opencode", OVERRIDE_FILENAME);
}

/**
 * Locate the project-local overrides file by walking upward from the current
 * working directory, so the project config is found even when opencode is
 * launched from a subdirectory. The walk is bounded by the project root: it
 * stops at the first ancestor containing a `.git` entry (after checking that
 * ancestor) or at the filesystem root, whichever comes first — so it never
 * escapes the repo into unrelated parent directories. Returns the resolved
 * path, or undefined when no file exists within the project.
 */
export function findProjectOverride(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, ".opencode", OVERRIDE_FILENAME);
    if (existsSync(candidate)) return candidate;
    // Reached the project root without finding the file — stop here.
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
}

export function statePath(): string {
  return join(
    homedir(),
    ".config",
    "opencode",
    "opencode-model-router.state.json",
  );
}

export function resolvePresetName(
  cfg: RouterConfig,
  requestedPreset: string,
): string | undefined {
  if (cfg.presets[requestedPreset]) {
    return requestedPreset;
  }

  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return Object.keys(cfg.presets).find(
    (name) => name.toLowerCase() === normalized,
  );
}

/** The valid enforcement-mode values, for validation. */
const ENFORCEMENT_MODES = ["off", "advisory", "enforced"] as readonly string[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validatePresets(obj: Record<string, unknown>): void {
  if (!isPlainObject(obj.presets)) {
    throw new Error("tiers.json: 'presets' must be a non-null object");
  }
  for (const [presetName, preset] of Object.entries(obj.presets)) {
    if (!isPlainObject(preset)) {
      throw new Error(`tiers.json: preset '${presetName}' must be an object`);
    }
    for (const [tierName, tier] of Object.entries(preset)) {
      if (typeof tier !== "object" || tier === null) {
        throw new Error(
          `tiers.json: tier '${presetName}.${tierName}' must be an object`,
        );
      }
      const t = tier as Record<string, unknown>;
      if (typeof t.model !== "string" || !t.model) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`,
        );
      }
      if (typeof t.description !== "string") {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.description' must be a string`,
        );
      }
      if (!Array.isArray(t.whenToUse)) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
        );
      }
    }
  }
}

function validateModes(obj: Record<string, unknown>): void {
  if (obj.modes === undefined) return;
  if (!isPlainObject(obj.modes)) {
    throw new Error("tiers.json: 'modes' must be an object");
  }
  for (const [modeName, mode] of Object.entries(obj.modes)) {
    if (typeof mode !== "object" || mode === null) {
      throw new Error(`tiers.json: mode '${modeName}' must be an object`);
    }
    const m = mode as Record<string, unknown>;
    if (typeof m.defaultTier !== "string") {
      throw new Error(
        `tiers.json: mode '${modeName}.defaultTier' must be a string`,
      );
    }
    if (typeof m.description !== "string") {
      throw new Error(
        `tiers.json: mode '${modeName}.description' must be a string`,
      );
    }
  }
}

function validateTierCaps(obj: Record<string, unknown>): void {
  if (obj.tierCaps === undefined) return;
  if (!isPlainObject(obj.tierCaps)) {
    throw new Error("tiers.json: 'tierCaps' must be an object");
  }
  for (const [tierName, cap] of Object.entries(obj.tierCaps)) {
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
      throw new Error(
        `tiers.json: tierCaps.'${tierName}' must be a positive integer`,
      );
    }
  }
}

function validateTierPrompts(obj: Record<string, unknown>): void {
  if (obj.tierPrompts === undefined) return;
  if (!isPlainObject(obj.tierPrompts)) {
    throw new Error("tiers.json: 'tierPrompts' must be an object");
  }
  for (const [tierName, prompt] of Object.entries(obj.tierPrompts)) {
    if (typeof prompt !== "string") {
      throw new Error(`tiers.json: tierPrompts.'${tierName}' must be a string`);
    }
  }
}

function validateTaskPatterns(obj: Record<string, unknown>): void {
  if (obj.taskPatterns === undefined) return;
  if (!isPlainObject(obj.taskPatterns)) {
    throw new Error("tiers.json: 'taskPatterns' must be an object");
  }
  for (const [tierName, patterns] of Object.entries(obj.taskPatterns)) {
    if (!Array.isArray(patterns)) {
      throw new Error(
        `tiers.json: taskPatterns.'${tierName}' must be an array of strings`,
      );
    }
  }
}

function validateEscalate(escalate: Record<string, unknown>): void {
  if (isPlainObject(escalate.costCeiling)) {
    const costCeiling = escalate.costCeiling;
    if (
      costCeiling.multiple !== undefined &&
      (typeof costCeiling.multiple !== "number" || costCeiling.multiple <= 0)
    ) {
      throw new Error(
        "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
      );
    }
  }
  if (escalate.ladder !== undefined) {
    if (
      !Array.isArray(escalate.ladder) ||
      !escalate.ladder.every((s: unknown) => typeof s === "string")
    ) {
      throw new Error(
        "tiers.json: enforcement.escalate.ladder must be an array of strings",
      );
    }
  }
  if (escalate.maxAttemptsPerTier !== undefined) {
    if (
      typeof escalate.maxAttemptsPerTier !== "number" ||
      !Number.isInteger(escalate.maxAttemptsPerTier) ||
      escalate.maxAttemptsPerTier < 0
    ) {
      throw new Error(
        "tiers.json: enforcement.escalate.maxAttemptsPerTier must be an integer >= 0",
      );
    }
  }
  if (escalate.maxTotalAttempts !== undefined) {
    if (
      typeof escalate.maxTotalAttempts !== "number" ||
      !Number.isInteger(escalate.maxTotalAttempts) ||
      escalate.maxTotalAttempts < 1
    ) {
      throw new Error(
        "tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1",
      );
    }
  }
  if (
    escalate.floorTier !== undefined &&
    escalate.floorTier !== null &&
    typeof escalate.floorTier !== "string"
  ) {
    throw new Error(
      "tiers.json: enforcement.escalate.floorTier must be a string or null",
    );
  }
}

function validateEnforcement(obj: Record<string, unknown>): void {
  if (obj.enforcement === undefined) return;
  if (!isPlainObject(obj.enforcement)) {
    throw new Error("tiers.json: enforcement must be an object");
  }
  const enforcement = obj.enforcement;

  if (
    enforcement.mode !== undefined &&
    !ENFORCEMENT_MODES.includes(enforcement.mode as string)
  ) {
    throw new Error(
      "tiers.json: enforcement.mode must be one of off|advisory|enforced",
    );
  }

  if (isPlainObject(enforcement.verify)) {
    const verify = enforcement.verify;
    if (
      verify.graderPolicy !== undefined &&
      verify.graderPolicy !== "atLeastProducerTier"
    ) {
      throw new Error(
        'tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"',
      );
    }
  }

  if (isPlainObject(enforcement.escalate)) {
    validateEscalate(enforcement.escalate);
  }

  if (isPlainObject(enforcement.perTier)) {
    for (const [tierName, tierMode] of Object.entries(enforcement.perTier)) {
      if (!ENFORCEMENT_MODES.includes(tierMode as string)) {
        throw new Error(
          `tiers.json: enforcement.perTier.${tierName} must be one of off|advisory|enforced`,
        );
      }
    }
  }

  if (isPlainObject(enforcement.guard)) {
    const guard = enforcement.guard;
    if (
      guard.budget !== undefined &&
      (typeof guard.budget !== "number" ||
        !Number.isFinite(guard.budget) ||
        guard.budget < 1)
    ) {
      throw new Error("enforcement.guard.budget must be a number >= 1");
    }
    if (
      guard.blockScriptWrites !== undefined &&
      typeof guard.blockScriptWrites !== "boolean"
    ) {
      throw new Error("enforcement.guard.blockScriptWrites must be a boolean");
    }
  }
}

export function validateConfig(raw: unknown): RouterConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tiers.json: expected a JSON object at root");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
  validatePresets(obj);
  if (!Array.isArray(obj.rules)) {
    throw new Error("tiers.json: 'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw new Error("tiers.json: 'defaultTier' must be a string");
  }
  validateModes(obj);
  validateTierCaps(obj);
  validateTierPrompts(obj);
  validateTaskPatterns(obj);
  validateEnforcement(obj);

  return raw as RouterConfig;
}

/**
 * Recursively merge `override` onto `base`. Plain objects merge key-by-key;
 * arrays and scalars are replaced wholesale (so e.g. an overridden `rules` or
 * `whenToUse` list replaces rather than appends). `undefined` values in the
 * override are skipped so they never blow away a base value.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] =
      key in result && isPlainObject(result[key]) && isPlainObject(value)
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

/**
 * Read and parse the optional user overrides file. Returns the parsed object,
 * or undefined when the file is absent/unreadable/invalid. Parse and shape
 * errors are surfaced via console.warn (never thrown) so a typo in the
 * overrides file can never brick opencode startup — but the user still gets a
 * visible reason why their override was ignored.
 */
function readOverridesAt(op: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    if (!existsSync(op)) return undefined;
    text = readFileSync(op, "utf-8");
  } catch {
    return undefined;
  }

  try {
    const parsed = parseJsonc(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(
        `[model-router] ignoring ${op}: expected a JSON object at root`,
      );
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.warn(
      `[model-router] ignoring ${op}: invalid JSONC — ${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * The ordered override layers (lowest priority first): global, then
 * project-local. Each present, well-formed file becomes a layer that is
 * deep-merged over the ones before it.
 */
export interface OverrideLayer {
  path: string;
  data: Record<string, unknown>;
}

function collectOverrideLayers(): OverrideLayer[] {
  const layers: OverrideLayer[] = [];
  // Lowest priority first: global, then project-local (found by upward search).
  const paths = [overridePath(), findProjectOverride()];
  for (const p of paths) {
    if (!p) continue;
    const data = readOverridesAt(p);
    if (data) layers.push({ path: p, data });
  }
  return layers;
}

export function loadConfig(): RouterConfig {
  if (_cachedConfig && !_configDirty) {
    return _cachedConfig;
  }

  const base = JSON.parse(readFileSync(configPath(), "utf-8"));
  const layers = collectOverrideLayers();

  // Bundled config must be valid on its own — throw otherwise (unchanged
  // behaviour). Override layers are then applied on top.
  let cfg = validateConfig(base);

  if (layers.length > 0) {
    const merge = (ls: OverrideLayer[]): unknown =>
      ls.reduce<unknown>((acc, l) => deepMerge(acc, l.data), base);

    try {
      cfg = validateConfig(merge(layers));
    } catch (err) {
      // A bad override must never brick startup, and one broken file must not
      // discard a good one. Fall back to the highest-priority layer that
      // validates on its own (so a broken personal/global file still lets a
      // shared project file apply), else the bundled defaults.
      console.warn(
        `[model-router] combined overrides are invalid (${(err as Error).message}); dropping conflicting layer(s)`,
      );
      for (let i = layers.length - 1; i >= 0; i--) {
        try {
          cfg = validateConfig(merge([layers[i]!]));
          for (let j = 0; j < layers.length; j++) {
            if (j !== i) {
              console.warn(`[model-router] dropped override layer ${layers[j]!.path}`);
            }
          }
          break;
        } catch (singleErr) {
          console.warn(
            `[model-router] ignoring ${layers[i]!.path}: ${(singleErr as Error).message}`,
          );
          cfg = validateConfig(base);
        }
      }
    }
  }

  try {
    if (existsSync(statePath())) {
      const state = JSON.parse(
        readFileSync(statePath(), "utf-8"),
      ) as RouterState;
      if (state.activePreset) {
        const resolved = resolvePresetName(cfg, state.activePreset);
        if (resolved) {
          cfg.activePreset = resolved;
        }
      }
      if (state.activeMode && cfg.modes?.[state.activeMode]) {
        cfg.activeMode = state.activeMode;
      }
      if (state.enforcementMode) {
        cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
      }
    }
  } catch {
    // Ignore state read errors and keep tiers.json defaults
  }

  _cachedConfig = cfg;
  _configDirty = false;
  return cfg;
}

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

/** Read current persisted state (or empty object on failure). */
export function readState(): RouterState {
  try {
    if (existsSync(statePath())) {
      return JSON.parse(readFileSync(statePath(), "utf-8")) as RouterState;
    }
  } catch {
    // ignore
  }
  return {};
}

/** Write state to disk atomically (merges with existing keys). */
export function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

/** Persist the active preset (no-op for an unknown preset name). */
export function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) return;
  cfg.activePreset = resolved;
  // Persist user-selected preset to state file only — never mutate tiers.json.
  writeState({ activePreset: resolved });
  // Invalidate cache so the next read picks up the new active preset.
  invalidateConfigCache();
}

/** Persist the active routing mode (no-op for an unknown mode name). */
export function saveActiveMode(modeName: string): void {
  const cfg = loadConfig();
  if (!cfg.modes?.[modeName]) return;
  cfg.activeMode = modeName;
  writeState({ activeMode: modeName });
  invalidateConfigCache();
}

/** Persist the enforcement mode. */
export function saveEnforcementMode(mode: "off" | "advisory" | "enforced"): void {
  writeState({ enforcementMode: mode });
  invalidateConfigCache();
}

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export function normalizeEnforcement(
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } {
  return { mode: e?.mode ?? "advisory" };
}
