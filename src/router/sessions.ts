import type { RouterConfig } from "./config";
import { fingerprintToolCall } from "../guard/fingerprint";
import { DEFAULT_IDLE_TTL_MS } from "./idle-sweep";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cap = number | "none";

export interface SubagentState {
  tierName: string;
  cap: Cap;
  /** Read-only tool calls in the CURRENT dispatch round (reset on resume). */
  calls: number;
  /** Number of dispatch rounds registered for this session (1 on first dispatch). */
  dispatches: number;
  /** Cumulative read-only tool calls across all dispatch rounds (never reset). */
  totalCalls: number;
  /** Fingerprint → call index where this fingerprint was first seen. */
  seen: Map<string, number>;
  trivial: boolean;
}

/** Outcome of a chat.message registration attempt. */
export interface RegisterResult {
  /** True when the message was directed at a tracked tier agent. */
  registered: boolean;
  /** True when this was a same-session, same-tier re-registration (a resume). */
  resumed: boolean;
}

// ---------------------------------------------------------------------------
// Fallback caps when tiers.json has no tierCaps block.
// ---------------------------------------------------------------------------

/** Fallback caps when tiers.json has no tierCaps block. */
export const DEFAULT_TIER_CAPS: Record<string, number> = {
  fast: 8,
  medium: 5,
  heavy: 3,
};

/**
 * Cumulative read-only ceiling across resumed dispatches, expressed as a
 * multiple of the CURRENT dispatch cap. A subagent that keeps getting resumed
 * gets a fresh per-dispatch budget every round; without a ceiling derived from
 * the configured budget, repeated resumes are an unbounded read loop.
 * A `CAP:none` dispatch has no per-dispatch budget to derive from, so it has
 * no cumulative ceiling either.
 */
export const CUMULATIVE_CAP_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Cap directive parser
// ---------------------------------------------------------------------------

/** Extract the first `CAP:N` or `CAP:none` directive from a dispatch prompt. */
export function parseCapDirective(text: string): Cap | null {
  const m = text.match(/\bCAP\s*:\s*(none|\d+)\b/i);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  if (raw === "none") return "none";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Dispatch text extractor (internal)
// ---------------------------------------------------------------------------

/** Best-effort extraction of textual content from a chat.message output payload. */
function extractDispatchText(output: unknown): string {
  const o = output as Record<string, unknown> | undefined;
  const parts = (o?.parts as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      chunks.push(p);
    } else if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      if (typeof rec.text === "string") chunks.push(rec.text);
      else if (typeof rec.content === "string") chunks.push(rec.content);
    }
  }
  if (chunks.length === 0) {
    const msg = o?.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (typeof content === "string") chunks.push(content);
  }
  return chunks.join("\n");
}

// ---------------------------------------------------------------------------
// Cap banner builder
// ---------------------------------------------------------------------------

/** Build the banner appended to every read-only tool result in a subagent session. */
export function buildCapBanner(
  state: SubagentState,
  isRedundant: boolean,
  previousCall: number | undefined,
  tool: string,
): string {
  const lines: string[] = [];
  const capDisplay = state.cap === "none" ? "∞" : String(state.cap);
  lines.push(`[cap: ${state.calls}/${capDisplay}]`);

  if (isRedundant && previousCall !== undefined) {
    lines.push(
      `[⚠ REDUNDANT: this is the same ${tool} you ran at call #${previousCall}. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]`,
    );
  }

  if (state.cap !== "none") {
    const remaining = state.cap - state.calls;
    if (remaining <= 0) {
      lines.push(
        `[⚠ CAP REACHED (${state.calls}/${state.cap}): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]`,
      );
    } else if (remaining <= 2) {
      lines.push(
        `[⚠ CAP WARNING: ${remaining} read-only call(s) remaining before forced return]`,
      );
    }

    // Cumulative ceiling across resumed dispatches. Intentionally follows the
    // CURRENT dispatch cap: a tighter resumed cap makes the ceiling stricter,
    // so a resume can never buy more total budget than it declares.
    const cumulativeCeiling = state.cap * CUMULATIVE_CAP_MULTIPLIER;
    if (state.totalCalls > cumulativeCeiling) {
      lines.push(
        `[⚠ CUMULATIVE BUDGET EXCEEDED: ${state.totalCalls}/${cumulativeCeiling} across ${state.dispatches} dispatches — return now]`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Read-only tools set (used by the session store)
// ---------------------------------------------------------------------------

/** Tools that count against the read-only cap. Keep narrow — editing tools should never count. */
export const READ_ONLY_TOOLS = new Set(["grep", "read", "glob", "ls"]);

// ---------------------------------------------------------------------------
// Trivial classifier
// ---------------------------------------------------------------------------

/** Normalise a taskPattern keyword to a lowercase stem for substring matching. */
function normTaskKw(kw: string): string {
  return kw.toLowerCase().split("(")[0]!.split("/")[0]!.trim();
}

/**
 * Classify a dispatch as "trivial" AT DISPATCH TIME (m2): conservative,
 * tier-gated. Only a `fast`-tier dispatch whose text matches a fast taskPattern
 * and contains NO medium/heavy signal is trivial. Real work (medium/heavy tier,
 * or implementation keywords) is NEVER trivial — so proportional bypass can
 * never silently disable enforcement on real work.
 */
export function classifyTrivial(
  dispatchText: string,
  tier: string | null,
  cfg: RouterConfig,
): boolean {
  if (tier !== "fast") return false;
  const text = (dispatchText || "").toLowerCase();
  if (!text.trim()) return false;
  const disqualifiers = [
    ...(cfg.taskPatterns?.medium ?? []),
    ...(cfg.taskPatterns?.heavy ?? []),
  ];
  for (const kw of disqualifiers) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return false;
  }
  const fast = cfg.taskPatterns?.fast ?? [];
  for (const kw of fast) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session store factory
// ---------------------------------------------------------------------------

export interface SessionStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Creates a per-plugin-instance session store that owns the subagent tracking
 * state (session IDs + cap state). Returns methods the hooks delegate to.
 * Concurrency: Set/Map are per-store-instance, NOT module-level singletons.
 *
 * Idle-TTL: registration and tool-call activity refresh a per-session lastTouch
 * stamp; `sweep()` evicts sessions idle for at least ttlMs. No timers.
 */
export function createSessionStore(options: SessionStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const subagentSessionIDs = new Set<string>();
  const subagentCapState = new Map<string, SubagentState>();
  const lastTouch = new Map<string, number>();

  function touch(sessionID: string): void {
    lastTouch.set(sessionID, now());
  }

  function evict(sessionID: string): void {
    subagentSessionIDs.delete(sessionID);
    subagentCapState.delete(sessionID);
    lastTouch.delete(sessionID);
  }

  return {
    /** Returns true when sessionID belongs to a tracked subagent session. */
    isSubagent(sessionID: string): boolean {
      return subagentSessionIDs.has(sessionID);
    },

    /** Returns the tier name for a tracked subagent session, or null. */
    getTier(sessionID: string): string | null {
      return subagentCapState.get(sessionID)?.tierName ?? null;
    },

    /** Returns true when the session was classified as trivial at dispatch time. */
    isTrivial(sessionID: string): boolean {
      return subagentCapState.get(sessionID)?.trivial === true;
    },

    /**
     * Register a plugin-created producer session (from the delegate tool) so that
     * Layer-1 (tool.execute.before) guards it like any other subagent. trivial:false
     * ensures the producer is always fully enforced (never downgraded to advisory).
     */
    registerProducerSession(sessionID: string, tier: string, cfg: RouterConfig): void {
      subagentSessionIDs.add(sessionID);
      const baseline = cfg.tierCaps?.[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5;
      subagentCapState.set(sessionID, {
        tierName: tier,
        cap: baseline,
        calls: 0,
        dispatches: 1,
        totalCalls: 0,
        seen: new Map(),
        trivial: false,
      });
      touch(sessionID);
    },

    /** Remove a session from tracking (used to clean up delegate producer sessions). */
    unregister(sessionID: string): void {
      evict(sessionID);
    },

    /**
     * Refresh a tracked session's idle stamp. Called when a tool call STARTS,
     * so that a session whose single tool call outlives the TTL is not evicted
     * mid-call by some other session's sweep — an eviction that would silently
     * drop cap enforcement for the rest of that session, because recordToolCall
     * returns early when the state is gone.
     *
     * Only touches sessions that are actually tracked. Touching unconditionally
     * is what created orphan lastTouch entries in the first place.
     */
    touchIfTracked(sessionID: string): boolean {
      if (!subagentCapState.has(sessionID)) return false;
      touch(sessionID);
      return true;
    },

    /** Evict every session idle for >= ttlMs. Future stamps are never evicted. */
    sweep(nowMs: number = now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): void {
      for (const [sessionID, stamp] of [...lastTouch.entries()]) {
        if (nowMs - stamp >= ttlMs) evict(sessionID);
      }
    },

    /**
     * Called from the chat.message hook. If the incoming message is directed
     * at a registered tier agent, records the session and initialises its cap state.
     * Accepts `tierNames` (from getActiveTiers) so this module doesn't need to
     * import protocol.ts.
     *
     * Resume detection: a re-registration of a session already tracked at the
     * SAME tier is a resumed dispatch (this is how an opencode task_id resume
     * manifests at the chat.message hook). A resume resets the per-dispatch
     * budget but preserves cumulative usage and read fingerprints.
     */
    registerFromChatMessage(
      input: { agent?: string; sessionID: string },
      output: unknown,
      cfg: RouterConfig,
      tierNames: string[],
    ): RegisterResult {
      if (!input.agent || !tierNames.includes(input.agent)) {
        return { registered: false, resumed: false };
      }

      subagentSessionIDs.add(input.sessionID);

      const tierName = input.agent;
      const dispatchText = extractDispatchText(output);
      const override = parseCapDirective(dispatchText);
      const baseline =
        cfg.tierCaps?.[tierName] ?? DEFAULT_TIER_CAPS[tierName] ?? 5;
      const cap: Cap = override ?? baseline;
      const trivial = classifyTrivial(dispatchText, tierName, cfg);
      const existing = subagentCapState.get(input.sessionID);

      // Same-tier re-registration = resumed dispatch. Reset only the
      // per-dispatch budget; `seen` is PRESERVED so redundancy detection
      // carries across dispatches, and totalCalls keeps feeding the
      // cumulative ceiling.
      if (existing?.tierName === tierName) {
        existing.cap = cap;
        existing.calls = 0;
        existing.dispatches += 1;
        existing.trivial = trivial;
        touch(input.sessionID);
        return { registered: true, resumed: true };
      }

      // No prior state (first dispatch, or an idle-TTL sweep evicted it) or a
      // different tier on the same sessionID: fresh session, fresh counters.
      subagentCapState.set(input.sessionID, {
        tierName,
        cap,
        calls: 0,
        dispatches: 1,
        totalCalls: 0,
        seen: new Map(),
        trivial,
      });
      touch(input.sessionID);
      return { registered: true, resumed: false };
    },

    /**
     * Called from the tool.execute.after hook. Appends a cap/redundancy banner
     * to the tool output for tracked subagent sessions running read-only tools.
     * Mutates outputRef.output in place (same as the inlined hook logic).
     */
    recordToolCall(
      input: { sessionID: string; tool: string; args: unknown },
      outputRef: Record<string, unknown>,
    ): void {
      const state = subagentCapState.get(input.sessionID);
      if (!state) return; // not a tracked subagent session
      // Touch AFTER the early return: touching first created a lastTouch entry
      // for every untracked session that ever ran a tool, and nothing else ever
      // removed it. Tracked sessions still refresh here, because the read-only
      // filter below runs later.
      touch(input.sessionID);
      if (!READ_ONLY_TOOLS.has(input.tool)) return;

      const fp = fingerprintToolCall(input.tool, input.args);
      const previousCall = state.seen.get(fp);
      const isRedundant = previousCall !== undefined;

      state.calls += 1;
      state.totalCalls += 1;
      if (!isRedundant) {
        state.seen.set(fp, state.calls);
      }

      const banner = buildCapBanner(state, isRedundant, previousCall, input.tool);

      const existing =
        typeof outputRef.output === "string" ? outputRef.output : "";
      outputRef.output = existing ? `${existing}\n\n${banner}` : banner;
    },
  };
}
