import type { Plugin, PluginInput } from "@opencode-ai/plugin";

// Imports for internal use within this module
import {
  loadConfig,
  resolvePresetName,
  saveActivePreset,
  saveActiveMode,
  saveEnforcementMode,
  overridePath,
  localOverridePath,
  findProjectOverride,
} from "./router/config";
import type { RouterConfig } from "./router/config";
import {
  buildAgentOptions,
  buildTiersOutput,
  buildPresetList,
  buildPresetSwitched,
  buildUnknownPreset,
  buildNoModes,
  buildBudgetList,
  buildBudgetSwitched,
  buildUnknownMode,
  buildBypassMessage,
  buildEnforceSet,
  buildEnforceStatus,
  buildRouterHelp,
  buildOverridesOutput,
  buildModelsOutput,
  formatModelIssues,
} from "./commands/output";
import { detectNarration } from "./guard/narration";
import {
  getActiveTiers,
  isClaudeModel,
  CLAUDE_TIER_PREFIX,
  CLAUDE_ANTI_NARRATION,
  assembleSystemPrompt,
} from "./router/protocol";
import { resolveEnforcementMode } from "./router/enforcement";
import {
  normalizeCatalog,
  validateModels,
} from "./router/catalog";
import type { Catalog, ModelIssue } from "./router/catalog";
import { createSessionStore, READ_ONLY_TOOLS } from "./router/sessions";
import type { Cap, SubagentState } from "./router/sessions";
import { createTrajectoryStore } from "./telemetry/trajectory";
import { createGuardStore } from "./guard/store";
import { guardBeforeCall, guardAfterCall, formatScorecard } from "./guard/enforce";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { scrubText } from "./guard/scrub";
import { accept } from "./verify/gate";
import {
  createChangedFileStore,
  parseTaskResult,
  buildDelegationDoD,
  tierModel,
  shouldVerifyTask,
  buildForcingNote,
  buildAcceptedSuffix,
} from "./verify/dispatch";
import { newLadderState, recordAttempt, nextAction, advance, buildEscalatePolicy } from "./escalate/ladder";
import { createVerificationWiring, extractAssistantText } from "./verify/wiring";

// ---------------------------------------------------------------------------
// Re-exports — type-only re-exports for IDE/test consumers.
// NOTE: value re-exports are intentionally absent. opencode's plugin loader
// calls every function export as a factory (Ck iterates Object.values(mod));
// adding named function exports would cause spurious factory calls.
// Tests import from their specific source files instead of this entry point.
// ---------------------------------------------------------------------------

export type { RouterConfig, TierConfig, Preset, ModeConfig, FallbackConfig, EnforcementConfig } from "./router/config";
export type { Cap, SubagentState };
export type { TrajectoryState, TrajectoryToolEvent } from "./telemetry/trajectory";
export type { EnforcementMode } from "./router/enforcement";
export type { GuardPolicy, GuardState, GuardCall, GuardDecision } from "./guard/guards";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const ModelRouterPlugin: Plugin = async (ctx: PluginInput) => {
  let cfg = loadConfig();
  const activeTiers = getActiveTiers(cfg);

  // Per-plugin-instance session store: owns subagentSessionIDs and subagentCapState.
  const sessionStore = createSessionStore();

  // Per-plugin-instance trajectory store (Phase 0.3 scaffolding — RECORD-ONLY).
  // Observes subagent tool activity to build a per-session scorecard. It emits
  // NOTHING into any model-visible output; the only externally observable effect
  // is an opt-in debug dump gated behind MODEL_ROUTER_TRAJECTORY_DEBUG=1.
  const trajectoryStore = createTrajectoryStore();

  // Per-plugin-instance guard state (Layer 1 hard-block). Only engaged for
  // subagent sessions when enforcement mode is advisory/enforced; in "off"
  // mode no guard state is ever created, so behaviour stays byte-identical.
  const guardStore = createGuardStore();

  const changedFileStore = createChangedFileStore();

  // Layer-2 verification wiring (grader dispatch, exec/fs seams, gate deps,
  // scorecard dump). getConfig() returns the current cfg so deps always reflect
  // the latest /preset and /router enforce changes.
  const verification = createVerificationWiring({
    client: ctx.client,
    directory: ctx.directory,
    getConfig: () => cfg,
  });
  const { buildGateDeps, dumpDelegateScorecard } = verification;

  // Bypass mode: when true, the router skips all system prompt injection,
  // subagent tracking, cap enforcement, and narration detection for the
  // current plugin lifetime (i.e., until OpenCode is restarted).
  let bypassed = false;

  // Fetch + normalize opencode's live provider/model catalog. Best-effort:
  // returns null if the client call fails (e.g. server not ready). The pure
  // analysis (validateModels) lives in src/router/catalog.ts.
  const fetchCatalog = async (): Promise<Catalog | null> => {
    try {
      const res: any = await ctx.client.config.providers();
      return normalizeCatalog(res?.data);
    } catch {
      return null;
    }
  };

  // One-shot guard so the passive "stale model" warning runs at most once per
  // plugin lifetime (re-validate on demand via /router).
  let catalogChecked = false;

  // The trajectory store is record-only debug scaffolding; its sole consumer is
  // the session.idle dump below. Read the gate once so per-event recording is a
  // true no-op (no map churn) unless explicitly enabled.
  const trajectoryDebug = process.env.MODEL_ROUTER_TRAJECTORY_DEBUG === "1";

  // Option (i): observe a finished native `task` delegation and, when enforcement
  // is on, append a forcing note if the result fails verification. Advisory-grade
  // (the task already ran, so we annotate rather than retry). Returns early for
  // every non-`task` tool call so the common path does no config/env work.
  const verifyDelegatedTask = async (input: any, output: any): Promise<void> => {
    if (input?.tool !== "task") return;
    let mode = "off";
    try {
      mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
    } catch {
      // fall through with mode "off"
    }
    if (!shouldVerifyTask("task", mode, cfg.enforcement?.verify?.require)) return;
    try {
      const { finalReturnText, childSessionID } = parseTaskResult(output);
      const producerTier =
        typeof input?.args?.subagent_type === "string"
          ? input.args.subagent_type
          : "";
      const dod = buildDelegationDoD({
        prompt: input?.args?.prompt,
        description: input?.args?.description,
      });
      const artefact = {
        changedFiles: childSessionID ? changedFileStore.get(childSessionID) : [],
        finalReturnText,
        declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
        producerSessionID: childSessionID ?? "",
        producerTier,
      };
      const trivial = childSessionID
        ? sessionStore.isTrivial(childSessionID)
        : false;
      const res = await accept(
        { dod, trivial, mode: "modeA" },
        artefact,
        buildGateDeps(),
      );
      if (!res.accepted && !res.verdict.skipped) {
        const ladder = cfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
        const li = ladder.indexOf(producerTier);
        const nextTier = li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
        const note = scrubText(
          buildForcingNote(res.verdict.reasons, { producerTier, nextTier }),
        );
        output.output =
          typeof output.output === "string"
            ? output.output + "\n\n" + note
            : note;
      }
      if (childSessionID) changedFileStore.clear(childSessionID);
    } catch {
      // fail-closed: a verification error must NEVER throw out of the after-hook
    }
  };

  // /preset [name] — show presets, or switch and persist. Uses closure cfg
  // (freshly reloaded by the command handler before this runs).
  const handlePreset = (args: string): string => {
    const requested = args.trim();
    if (!requested) return buildPresetList(cfg);
    const resolved = resolvePresetName(cfg, requested);
    if (!resolved) return buildUnknownPreset(cfg, requested);
    saveActivePreset(resolved);
    cfg.activePreset = resolved;
    return buildPresetSwitched(cfg, resolved);
  };

  // /budget [mode] — show modes, or switch and persist.
  const handleBudget = (args: string): string => {
    const modes = cfg.modes;
    if (!modes || Object.keys(modes).length === 0) return buildNoModes();
    const requested = args.trim().toLowerCase();
    if (!requested) return buildBudgetList(cfg);
    const mode = modes[requested];
    if (!mode) return buildUnknownMode(modes, requested);
    saveActiveMode(requested);
    return buildBudgetSwitched(mode, requested);
  };

  // /bypass [on|off] — toggle the router off/on for the session.
  const handleBypass = (args: string): string => {
    const arg = args.toLowerCase();
    bypassed = arg === "on" ? true : arg === "off" ? false : !bypassed;
    return buildBypassMessage(bypassed);
  };

  // /router [enforce|overrides|models] — uses the freshly-reloaded cfg.
  const handleRouterCommand = async (args: string): Promise<string> => {
    const parts = args.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? "").toLowerCase();

    if (sub === "enforce") {
      const mode = (parts[1] ?? "").toLowerCase();
      if (mode === "off" || mode === "advisory" || mode === "enforced") {
        saveEnforcementMode(mode);
        return buildEnforceSet(mode);
      }
      return buildEnforceStatus(
        resolveEnforcementMode({ config: cfg, env: process.env }).mode,
      );
    }

    if (sub === "overrides") {
      const foundLocal = findProjectOverride();
      const globalPath = overridePath();
      const localPath = foundLocal ?? localOverridePath();
      return buildOverridesOutput({
        globalPath,
        globalPresent: existsSync(globalPath),
        localPath,
        localPresent: existsSync(localPath),
        foundLocal: !!foundLocal,
        activePreset: cfg.activePreset,
      });
    }

    if (sub === "models") {
      return buildModelsOutput(await fetchCatalog(), parts.slice(1).join(" "));
    }

    // Bare /router: status help, plus inline stale/missing-model warnings.
    let text = buildRouterHelp(
      resolveEnforcementMode({ config: cfg, env: process.env }).mode,
    );
    if (sub === "") {
      const catalog = await fetchCatalog();
      if (catalog) {
        const issues = validateModels(cfg, catalog);
        if (issues.length > 0) text += "\n\n" + formatModelIssues(issues);
      }
    }
    return text;
  };

  const enableDelegateTool =
    cfg.experimental?.verifiedDelegateTool === true ||
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE === "1";

  return {
    tool: {
      ...(enableDelegateTool ? { delegate: tool({
        description:
          "Delegate a task to a tier subagent (fast | medium | heavy). The subagent's result is INDEPENDENTLY VERIFIED (deterministic checks, or an independent grader at >= the producer tier in a fresh session) before it is returned. Returns an accepted result on PASS, or an honest 'unmet' status on FAIL — never a self-reported completion. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.",
        args: {
          task: tool.schema
            .string()
            .describe("The task for the subagent to perform."),
          tier: tool.schema
            .string()
            .optional()
            .describe("fast | medium | heavy. Defaults to the router default tier."),
          acceptance: tool.schema
            .string()
            .optional()
            .describe(
              "Optional [acceptance]...[/acceptance] block defining the Definition of Done (check: / criteria: / deliverable: directives).",
            ),
        },
        async execute(args: {
          task: string;
          tier?: string;
          acceptance?: string;
        }): Promise<string> {
          try {
            let activeCfg = cfg;
            try {
              activeCfg = loadConfig();
            } catch {
              activeCfg = cfg;
            }
            const initialTier =
              typeof args.tier === "string" && args.tier.trim()
                ? args.tier.trim()
                : activeCfg.defaultTier || "medium";
            const dod = buildDelegationDoD({
              prompt: args.task,
              acceptance: args.acceptance,
            });

            const policy = buildEscalatePolicy(activeCfg);
            let state = newLadderState(initialTier, policy);
            const tiersForCost: any = getActiveTiers(activeCfg);

            // Independent safety net: even a policy bug cannot loop unbounded.
            const safetyMax =
              Math.max(
                policy.maxTotalAttempts,
                policy.ladder.length * (policy.maxAttemptsPerTier + 1),
              ) + 2;
            let safety = 0;

            // One produce→verify cycle: spin up a producer session at `tier`,
            // run the task, verify the result, and clean up. Returns the gate
            // verdict + producer text, or { ok: false } if the session could
            // not be created. A transport/API error during the prompt is caught
            // and surfaces as an empty artefact — counted by the ladder as
            // exactly one failed attempt (advisory provider-failover is handled
            // separately via the orchestrator system prompt, not here).
            const runProducerAttempt = async (tier: string, taskText: string) => {
              const created: any = await ctx.client.session.create({});
              const producerSid: string | undefined = created?.data?.id;
              if (!producerSid) return { ok: false as const };

              // Compose with Layer 1: guard the plugin-created producer session.
              try {
                sessionStore.registerProducerSession(producerSid, tier, activeCfg);
              } catch {
                // non-fatal
              }

              const model = tierModel(activeCfg, tier) ?? undefined;
              let producerText = "";
              try {
                const res: any = await ctx.client.session.prompt({
                  path: { id: producerSid },
                  body: {
                    ...(model ? { model } : {}),
                    ...(tier ? { agent: tier } : {}),
                    parts: [{ type: "text", text: taskText }],
                  },
                });
                producerText = extractAssistantText(res);
              } catch {
                producerText = "";
              }

              const artefact = {
                changedFiles: changedFileStore.get(producerSid),
                finalReturnText: producerText,
                declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
                producerSessionID: producerSid,
                producerTier: tier,
              };

              let gateRes;
              try {
                gateRes = await accept(
                  { dod, trivial: false, mode: "modeA" },
                  artefact,
                  buildGateDeps(),
                );
              } catch {
                gateRes = {
                  accepted: false,
                  verdict: {
                    pass: false,
                    method: "none" as const,
                    reasons: ["verification failed (fail-closed)"],
                  },
                  dodSource: dod.source,
                };
              }

              // Per-attempt cleanup (drop producer session tracking + state).
              changedFileStore.clear(producerSid);
              try {
                sessionStore.unregister(producerSid);
              } catch {
                // non-fatal
              }
              try {
                guardStore.clear(producerSid);
              } catch {
                // non-fatal
              }

              const costRatio =
                typeof tiersForCost?.[tier]?.costRatio === "number"
                  ? tiersForCost[tier].costRatio
                  : 1;

              return { ok: true as const, producerSid, producerText, gateRes, costRatio };
            };

            let producerText = "";
            let forcing: string | null = null;

            while (true) {
              if (safety++ > safetyMax) {
                return (
                  `[router status: unmet] delegation stopped by the safety net after ` +
                  `${state.totalAttempts} attempt(s).\n\n${scrubText(producerText)}`
                );
              }
              const taskText = forcing
                ? `${scrubText(forcing)}\n\n${args.task}`
                : args.task;

              const attempt = await runProducerAttempt(state.currentTier, taskText);
              if (!attempt.ok) {
                return "[router] delegate failed: could not create a producer session.";
              }
              const { producerSid, gateRes, costRatio } = attempt;
              producerText = attempt.producerText;

              state = recordAttempt(state, costRatio);
              const action = nextAction(
                state,
                { pass: gateRes.accepted, reasons: gateRes.verdict.reasons },
                policy,
              );

              if (action.action === "accept") {
                dumpDelegateScorecard(producerSid, state, true, gateRes.verdict.method);
                return producerText + buildAcceptedSuffix(gateRes.verdict.method);
              }
              if (action.action === "give_up") {
                dumpDelegateScorecard(producerSid, state, false, gateRes.verdict.method);
                const note = scrubText(buildForcingNote(gateRes.verdict.reasons));
                return (
                  `[router status: unmet] The delegated result was not accepted after ` +
                  `${state.totalAttempts} attempt(s) across ${state.escalations} escalation(s) ` +
                  `(final tier ${state.currentTier}; ${action.reason ?? "verification failed"}).\n\n` +
                  `${scrubText(producerText)}\n\n${note}`
                );
              }
              // retry or escalate
              forcing = action.forcingMessage ?? null;
              state = advance(state, action);
            }
          } catch {
            return "[router] delegate failed (fail-closed): the delegation or verification could not complete.";
          }
        },
      }) } : {}),
    },

    // Grader sessions run at temperature 0 for deterministic verdicts.
    "chat.params": async (input: any, output: any) => {
      try {
        if (input?.sessionID && verification.isGraderSession(input.sessionID)) {
          output.temperature = cfg.enforcement?.verify?.graderTemperature ?? 0;
        }
      } catch {
        // best-effort: never crash a real session
      }
    },

    // -----------------------------------------------------------------------
    // Detect subagent calls via chat.message. When the agent name matches a
    // registered tier, record the sessionID so system.transform can skip
    // delegation-protocol injection.
    //
    // IMPORTANT: must be chat.message, NOT chat.params. The opencode hook
    // order is chat.message -> system.transform -> chat.params, so populating
    // the Set in chat.params is always one step too late — system.transform
    // already ran with an empty Set and leaked the "Delegate with Task(...)"
    // instructions into the subagent's system prompt. Sonnet subagents like
    // @explore silently ignore that noise, but literal-minded Haiku (@fast)
    // emits malformed XML tool calls for the nonexistent Task tool, which
    // surface in the UI as "<parameter>...</parameter>" leakage.
    //
    // chat.message fires inside SessionPrompt.createUserMessage() BEFORE the
    // loop -> LLM.stream path, so by the time system.transform runs the Set
    // is fully populated and await-safe (yield* on the plugin trigger).
    // -----------------------------------------------------------------------
    "chat.message": async (input: any, output: any) => {
      if (bypassed) return;
      // Re-read cfg so /preset switches take effect without restart
      try {
        cfg = loadConfig();
      } catch {}
      const tierNames = Object.keys(getActiveTiers(cfg));
      sessionStore.registerFromChatMessage(input, output, cfg, tierNames);

      // Record-only: initialise a trajectory scorecard for tracked subagents.
      const sid = input?.sessionID;
      if (trajectoryDebug && sid && sessionStore.isSubagent(sid)) {
        trajectoryStore.ensure(sid, input?.agent ?? null);
      }

      // Once per lifetime, warn (in the plugin log) if the active preset points
      // at models that opencode's catalog says are missing or deprecated. Only
      // for orchestrator sessions; best-effort and never throws.
      if (!catalogChecked && sid && !sessionStore.isSubagent(sid)) {
        catalogChecked = true;
        try {
          const catalog = await fetchCatalog();
          if (catalog) {
            for (const it of validateModels(cfg, catalog)) {
              const hint =
                it.suggestions.length > 0
                  ? ` — try ${it.suggestions.join(", ")}`
                  : "";
              console.warn(
                `[model-router] @${it.tier} ${it.ref}: ${it.kind}${hint}`,
              );
            }
          }
        } catch {
          // best-effort: never disrupt a real session
        }
      }
    },

    // -----------------------------------------------------------------------
    // Hard-block enforcement (Layer 1). Fires before tool execution; only
    // engaged for subagent sessions when enforcement mode is advisory/enforced.
    // Throws to abort the tool call when a guard fires; never throws for
    // non-subagent sessions or when enforcement is off (GA-1 preserved).
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      if (bypassed) return;
      const sid = input?.sessionID;
      if (!sid || !sessionStore.isSubagent(sid) || typeof input?.tool !== "string") {
        return;
      }
      let res;
      try {
        res = guardBeforeCall({
          cfg,
          tier: sessionStore.getTier(sid),
          trivial: sessionStore.isTrivial(sid),
          sessionID: sid,
          tool: input.tool,
          toolArgs: output?.args,
          store: guardStore,
          env: process.env,
        });
      } catch {
        return; // never break a real session on a guard-internal error
      }
      if (res.block) {
        if (trajectoryDebug) {
          trajectoryStore.recordToolEvent(sid, {
            tool: input.tool,
            readOnly: READ_ONLY_TOOLS.has(input.tool),
            blocked: true,
            selfScript: res.guard === "anti_self_script",
          });
        }
        throw new Error(res.message);
      }
    },

    // -----------------------------------------------------------------------
    // Runtime cap + redundancy enforcement (subagents only).
    // Appends `[cap: N/MAX]` and `[⚠ REDUNDANT]` / `[⚠ CAP REACHED]` banners
    // to every read-only tool result the subagent sees. Because these land
    // inside `output.output` — the tool's own response text — the model
    // treats them as ground truth rather than advisory system noise.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      if (bypassed) return;
      sessionStore.recordToolCall(input, output);

      // Record-only trajectory observation (mutates internal maps only; never
      // touches output, so emitted banners/observations stay byte-identical).
      const sid = input?.sessionID;

      // Attribute changed files to whichever session made the edit (any session).
      if (sid && typeof input?.tool === "string") {
        changedFileStore.record(sid, input.tool, input?.args);
      }

      if (sid && sessionStore.isSubagent(sid) && typeof input?.tool === "string") {
        if (trajectoryDebug) {
          trajectoryStore.recordToolEvent(sid, {
            tool: input.tool,
            readOnly: READ_ONLY_TOOLS.has(input.tool),
          });
        }
        try {
          guardAfterCall({
            cfg,
            tier: sessionStore.getTier(sid),
            sessionID: sid,
            tool: input.tool,
            toolArgs: input?.args,
            output,
            store: guardStore,
          });
        } catch {
          // best-effort: enforcement must never crash a real session
        }
      }

      await verifyDelegatedTask(input, output);
    },

    // -----------------------------------------------------------------------
    // Narration detector — flags progress-commentary-without-production.
    //
    // Fires per completed text part. Scans for narration patterns; if any
    // match, logs a warning to the plugin console and appends a visible
    // banner to the text so the user sees the detection in the UI. This is
    // telemetry, not blocking — we cannot modify mid-stream generation, only
    // post-hoc signal.
    // -----------------------------------------------------------------------
    "experimental.text.complete": async (input: any, output: any) => {
      if (bypassed || !cfg.antiNarration) return;
      const text = output?.text;
      if (typeof text !== "string" || text.length < 20) return;

      const found = detectNarration(text);
      if (found.length === 0) return;

      const quoted = found
        .map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`)
        .join(", ");
      output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
    },

    // -----------------------------------------------------------------------
    // Gated trajectory debug dump (Phase 0.3, T0.3.3) — RECORD-ONLY, OPT-IN.
    // No-op unless MODEL_ROUTER_TRAJECTORY_DEBUG=1. On session.idle, writes the
    // session's trajectory scorecard to a throwaway file under the OS temp dir
    // for manual inspection. Best-effort; never throws into the session.
    // Emits nothing model-visible, so GA-1 (no-regression) is preserved.
    // -----------------------------------------------------------------------
    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return;
      const sid = event?.properties?.sessionID;
      if (typeof sid !== "string") return;

      // Per-delegation scorecard: only when enforcement was active (guard state exists).
      try {
        const gstate = guardStore.get(sid);
        if (gstate) {
          const line = formatScorecard(gstate, sessionStore.getTier(sid));
          const dir = join(tmpdir(), "opencode-model-router-trajectory");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${sid}.scorecard.log`), line + "\n", { flag: "a" });
        }
      } catch {
        // best-effort: a scorecard must never crash a real session
      }

      // Opt-in full trajectory dump (unchanged gating).
      if (!trajectoryDebug) return;
      const dump = trajectoryStore.dump(sid);
      if (!dump) return;
      try {
        const dir = join(tmpdir(), "opencode-model-router-trajectory");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sid}.log`), dump + "\n", { flag: "a" });
      } catch {
        // best-effort
      }
    },

    // -----------------------------------------------------------------------
    // Register tier agents + commands at load time
    // -----------------------------------------------------------------------
    config: async (opencodeConfig: any) => {
      opencodeConfig.agent ??= {};

      for (const [name, tier] of Object.entries(activeTiers)) {
        // Resolve prompt: per-tier override wins; otherwise fall back to global tierPrompts[name].
        const resolvedPrompt = tier.prompt ?? cfg.tierPrompts?.[name];

        // For Claude-backed tiers, prepend an adversarial opener that revokes
        // the cached "Claude Code exploratory agent" priming for this dispatch.
        // Detection is by model string, so hybrid presets get the override
        // only on their Claude-backed tiers.
        const claudePrefix = isClaudeModel(tier.model)
          ? cfg.antiNarration
            ? `${CLAUDE_TIER_PREFIX[name]}\n\n${CLAUDE_ANTI_NARRATION}`
            : CLAUDE_TIER_PREFIX[name]
          : undefined;
        const finalPrompt =
          claudePrefix && resolvedPrompt
            ? `${claudePrefix}\n\n---\n\n${resolvedPrompt}`
            : resolvedPrompt;

        const agentDef: Record<string, unknown> = {
          model: tier.model,
          mode: "subagent",
          description: tier.description ?? `@${name} tier (${tier.model})`,
          maxSteps: tier.steps,
          prompt: finalPrompt,
          color: tier.color,
        };

        // Apply variant (thinking/reasoning mode)
        if (tier.variant) {
          agentDef.variant = tier.variant;
        }

        // Apply provider-specific options
        const opts = buildAgentOptions(tier);
        if (Object.keys(opts).length > 0) {
          agentDef.options = opts;
        }

        opencodeConfig.agent[name] = agentDef;
      }

      // Register commands
      opencodeConfig.command ??= {};
      opencodeConfig.command["tiers"] = {
        template: "",
        description: "Show model delegation tiers and rules",
      };
      opencodeConfig.command["preset"] = {
        template: "$ARGUMENTS",
        description: "Show or switch model presets (e.g., /preset openai)",
      };
      opencodeConfig.command["budget"] = {
        template: "$ARGUMENTS",
        description:
          "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
      };
      opencodeConfig.command["bypass"] = {
        template: "$ARGUMENTS",
        description:
          "Toggle model-router bypass (disables delegation protocol for this session)",
      };
      opencodeConfig.command["annotate-plan"] = {
        template: [
          "Annotate the plan with tier directives for model delegation.",
          "",
          'Plan file: "$ARGUMENTS"',
          "If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.",
          "",
          "## Available tiers",
          "- `[tier:fast]` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.",
          "- `[tier:medium]` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.",
          "- `[tier:heavy]` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.",
          "",
          "## Annotation rules",
          "1. Place `[tier:X]` at the START of each step, before the description",
          "2. Research/exploration -> `[tier:fast]` (preferred)",
          "3. Implementation/code -> `[tier:medium]` (preferred)",
          "4. Architecture/security/hard debugging -> `[tier:heavy]`",
          "5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
          "6. Verification (run tests, build) -> `[tier:medium]`",
          "7. Trivial (single grep or file read) -> `[tier:fast]`",
          "8. Final review of the complete plan -> `[tier:heavy]`",
          "",
          "## Output",
          "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.",
          "",
          "## Acceptance blocks (for enforcement)",
          "For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can verify the work:",
          "[acceptance]",
          "check: <testsPass | buildPasses | lintClean | fileExists path=... | run command=\"...\" expect=...>",
          "criteria: <plain-language success condition, when no deterministic check applies>",
          "deliverable: <path or short description>",
          "[/acceptance]",
          "Prefer deterministic checks (testsPass/buildPasses/fileExists). Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.",
        ].join("\n"),
        description:
          "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
      };
      opencodeConfig.command["router"] = {
        template: "$ARGUMENTS",
        description:
          "Model-router controls (e.g., /router enforce off|advisory|enforced, /router overrides, /router models)",
      };
    },

    // -----------------------------------------------------------------------
    // Inject delegation protocol — uses cached config (invalidated on /preset or /budget)
    // Only inject for the primary orchestrator, NOT for subagent calls.
    // Subagents get confused by delegation instructions when they should
    // just execute a task (especially smaller models like Haiku).
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      if (bypassed) return;
      try {
        cfg = loadConfig(); // Returns cache unless invalidated
      } catch {
        // Use last known config if file read fails
      }

      // Skip injection for child (subagent) sessions.
      // Child sessions are detected via session.created events with a parentID.
      const sessionID = _input?.sessionID;
      if (sessionID && sessionStore.isSubagent(sessionID)) return;

      // For Claude-backed orchestrators, prepend an adversarial opener that
      // revokes the cached "Claude Code explorer" priming for the routing
      // role. Detection is by orchestrator model, not preset.
      const providerID = _input?.model?.providerID ?? "";
      const modelID = _input?.model?.modelID ?? "";
      const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;

      let enfOn = false;
      try { enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off"; } catch {}
      output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, and /budget commands
    // -----------------------------------------------------------------------
    "command.execute.before": async (input: any, output: any) => {
      const args = (input.arguments ?? "").trim();
      const reload = () => {
        try {
          cfg = loadConfig();
        } catch {}
      };
      const push = (text: string) =>
        output.parts.push({ type: "text" as const, text });

      switch (input.command) {
        case "tiers":
          reload();
          push(buildTiersOutput(cfg));
          break;
        case "preset":
          reload();
          push(handlePreset(args));
          break;
        case "budget":
          reload();
          push(handleBudget(args));
          break;
        case "bypass":
          push(handleBypass(args));
          break;
        case "router":
          reload();
          push(await handleRouterCommand(args));
          break;
      }
    },
  };
};

export default ModelRouterPlugin;
