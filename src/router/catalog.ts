// ---------------------------------------------------------------------------
// src/router/catalog.ts — model catalog normalization, validation, and
// suggestions. PURE module: no fs/network/SDK/process.env. The async fetch of
// opencode's live catalog (client.config.providers()) happens in index.ts; the
// raw payload is handed here for normalization and analysis.
// ---------------------------------------------------------------------------

import type { RouterConfig } from "./config";
import { getActiveTiers } from "./protocol";

export interface CatalogModel {
  id: string;
  /** "active" | "alpha" | "beta" | "deprecated" when known. */
  status?: string;
}

export interface CatalogProvider {
  id: string;
  name?: string;
  /** opencode's default model id for this provider, when known. */
  defaultModel?: string;
  models: CatalogModel[];
}

export interface Catalog {
  providers: CatalogProvider[];
}

/**
 * Normalize the raw `client.config.providers()` payload
 * (`{ providers: Provider[], default: { [providerId]: modelId } }`) into the
 * minimal shape this module needs. Defensive against missing/oddly-typed fields
 * so a catalog-shape change never throws.
 */
export function normalizeCatalog(raw: unknown): Catalog {
  const providers: CatalogProvider[] = [];
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const defaults =
      r.default && typeof r.default === "object"
        ? (r.default as Record<string, unknown>)
        : {};
    const list = Array.isArray(r.providers) ? r.providers : [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const prov = p as Record<string, unknown>;
      if (typeof prov.id !== "string") continue;
      const modelsObj =
        prov.models && typeof prov.models === "object"
          ? (prov.models as Record<string, unknown>)
          : {};
      const models: CatalogModel[] = Object.entries(modelsObj).map(
        ([key, m]) => {
          const mm = (m && typeof m === "object" ? m : {}) as Record<
            string,
            unknown
          >;
          return {
            id: typeof mm.id === "string" ? mm.id : key,
            status: typeof mm.status === "string" ? mm.status : undefined,
          };
        },
      );
      const def = defaults[prov.id];
      providers.push({
        id: prov.id,
        name: typeof prov.name === "string" ? prov.name : undefined,
        defaultModel: typeof def === "string" ? def : undefined,
        models,
      });
    }
  }
  return { providers };
}

/** True when the catalog carries no usable provider data (fetch failed/empty). */
export function isCatalogEmpty(catalog: Catalog): boolean {
  return catalog.providers.length === 0;
}

/**
 * Split a tier model reference (`"provider/model"`) into its parts. Splits on
 * the FIRST slash only, so multi-segment model ids (e.g.
 * `openrouter/deepseek/deepseek-v3.2`) keep their full model id.
 */
export function parseModelRef(
  ref: string,
): { providerId: string; modelId: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

function findProvider(
  catalog: Catalog,
  providerId: string,
): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.id === providerId);
}

/** Levenshtein edit distance (iterative, two-row). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * Rank a provider's model ids by closeness to `target`, preferring non-deprecated
 * models. Returns up to `limit` model ids.
 */
export function suggestModels(
  target: string,
  models: CatalogModel[],
  limit = 3,
): string[] {
  return models
    .map((m) => ({
      id: m.id,
      deprecated: m.status === "deprecated" ? 1 : 0,
      dist: editDistance(target, m.id),
    }))
    .sort((a, b) => a.deprecated - b.deprecated || a.dist - b.dist || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((m) => m.id);
}

export type ModelIssueKind =
  | "provider-unknown"
  | "model-missing"
  | "model-deprecated";

export interface ModelIssue {
  tier: string;
  /** Full `provider/model` reference from the config. */
  ref: string;
  providerId: string;
  modelId: string;
  kind: ModelIssueKind;
  /** Suggested full `provider/model` references, closest first. */
  suggestions: string[];
}

/**
 * Validate the active preset's tier models against the live catalog. Returns an
 * empty list when the catalog is empty (fetch failed) — we never cry wolf about
 * missing models when we couldn't see the catalog at all.
 */
export function validateModels(cfg: RouterConfig, catalog: Catalog): ModelIssue[] {
  if (isCatalogEmpty(catalog)) return [];

  const issues: ModelIssue[] = [];
  const preset = getActiveTiers(cfg);

  for (const [tier, tierCfg] of Object.entries(preset)) {
    const ref = tierCfg?.model;
    if (typeof ref !== "string") continue;
    const parsed = parseModelRef(ref);
    if (!parsed) continue;

    const provider = findProvider(catalog, parsed.providerId);
    if (!provider) {
      issues.push({
        tier,
        ref,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        kind: "provider-unknown",
        suggestions: [],
      });
      continue;
    }

    const model = provider.models.find((m) => m.id === parsed.modelId);
    if (!model) {
      issues.push({
        tier,
        ref,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        kind: "model-missing",
        suggestions: suggestModels(parsed.modelId, provider.models).map(
          (id) => `${parsed.providerId}/${id}`,
        ),
      });
      continue;
    }

    if (model.status === "deprecated") {
      const alternatives = provider.models.filter(
        (m) => m.status !== "deprecated",
      );
      issues.push({
        tier,
        ref,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        kind: "model-deprecated",
        suggestions: suggestModels(parsed.modelId, alternatives).map(
          (id) => `${parsed.providerId}/${id}`,
        ),
      });
    }
  }

  return issues;
}
