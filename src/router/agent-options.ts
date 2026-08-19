/**
 * Registration-path agent options.
 *
 * `src/index.ts` turns each tier of the active preset into an opencode agent
 * definition; this module owns the `options` bag on that definition. It is the
 * only place that knows how a tier's provider-agnostic `effort` maps onto the
 * provider-specific knob (`effort` for Anthropic, `reasoning_effort` for
 * OpenAI) and what to do when a tier asks for something the provider cannot do.
 *
 * The display-path builder in `src/commands/output.ts` renders what a tier is
 * configured with; this one decides what is actually sent. They are kept apart
 * on purpose: `/tiers` should not warn, downgrade or drop keys.
 */
import type { TierConfig } from "./config";
import { EFFORT_LEVELS } from "./config";
import { isClaudeModel } from "./protocol";

// ---------------------------------------------------------------------------
// Warn-once
// ---------------------------------------------------------------------------

// Agent registration runs on every `config` hook, so an unqualified
// console.warn would repeat the same line for the life of the session. Keys are
// deliberately tight (tier name + offending value where the value matters), so
// two different mistakes are still two different warnings.
const warnedAgentOptionsEffort = new Set<string>();

export function warnAgentOptionsEffortOnce(key: string, message: string): void {
  if (warnedAgentOptionsEffort.has(key)) return;
  warnedAgentOptionsEffort.add(key);
  console.warn(`[model-router] ${message}`);
}

export function resetAgentOptionsEffortWarnings(): void {
  warnedAgentOptionsEffort.clear();
}

function isEffortLevel(value: unknown): value is (typeof EFFORT_LEVELS)[number] {
  return typeof value === "string" && EFFORT_LEVELS.some((level) => level === value);
}

function isOpenAIModel(model: string): boolean {
  const s = model.toLowerCase();
  return s.startsWith("openai/") || /\bgpt-/.test(s) || /(^|[/\-_])o[134]([/\-_]|$)/.test(s);
}

/**
 * Provider-specific agent options for a tier, as registered with opencode.
 *
 * Precedence, highest first: explicit `thinking` (Anthropic) or explicit
 * `reasoning.effort` (OpenAI), then the provider-agnostic `effort`. A key is
 * only ever present when something asked for it — an unset `effort` leaves no
 * trace in the returned object.
 */
export function buildAgentOptions(tier: TierConfig, tierName = tier.model): Record<string, unknown> {
  const opts: Record<string, unknown> = {};

  // Anthropic thinking config
  if (tier.thinking?.budgetTokens != null) {
    if (tier.thinking.budgetTokens) {
      opts.budget_tokens = tier.thinking.budgetTokens;
    }
  }

  // OpenAI reasoning config
  if (tier.reasoning) {
    if (tier.reasoning.effort) {
      opts.reasoning_effort = tier.reasoning.effort;
    }
    if (tier.reasoning.summary) {
      opts.reasoning_summary = tier.reasoning.summary;
    }
  }

  const effort: unknown = tier.effort;
  if (effort !== undefined) {
    if (!isEffortLevel(effort)) {
      // Loading tiers.json rejects this, but an override layer or a
      // programmatic caller can still hand us junk. Ignore it rather than
      // failing registration for the whole preset.
      warnAgentOptionsEffortOnce(
        `invalid:${tierName}:${String(effort)}`,
        `tier ${tierName}: invalid effort '${String(effort)}' ignored`,
      );
    } else if (isClaudeModel(tier.model)) {
      if (tier.thinking?.budgetTokens != null) {
        warnAgentOptionsEffortOnce(
          `anthropic-conflict:${tierName}`,
          `tier ${tierName}: both thinking and effort set; explicit thinking wins`,
        );
      } else {
        opts.effort = effort;
      }
    } else if (isOpenAIModel(tier.model)) {
      if (tier.reasoning?.effort) {
        warnAgentOptionsEffortOnce(
          `openai-conflict:${tierName}`,
          `tier ${tierName}: both reasoning.effort and effort set; explicit reasoning wins`,
        );
      } else if (effort === "xhigh" || effort === "max") {
        warnAgentOptionsEffortOnce(
          `openai-downgrade:${tierName}:${effort}`,
          `tier ${tierName}: downgrading effort '${effort}' to 'high' because OpenAI reasoning_effort only supports low, medium, or high`,
        );
        opts.reasoning_effort = "high";
      } else {
        opts.reasoning_effort = effort;
      }
    } else {
      warnAgentOptionsEffortOnce(
        `unknown-provider:${tierName}`,
        `tier ${tierName}: effort ignored for unknown provider family '${tier.model}'`,
      );
    }
  }

  return opts;
}
