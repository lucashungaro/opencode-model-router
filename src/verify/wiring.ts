/**
 * The impure corner of Layer 2.
 *
 * Everything else under src/verify/ is pure: the gate, the DoD schema, the
 * deterministic checks and the grader protocol all take their side effects as
 * injected deps. This module is where those deps are actually built out of a
 * child_process, a filesystem and an opencode client, so the impurity lives in
 * one named place instead of spread through the plugin factory.
 *
 * Config is read through a getter rather than captured. `cfg` in index.ts is a
 * `let` that is reassigned whenever a command reloads it, so a snapshot taken
 * at construction would leave the grader pinned to the models and enforcement
 * settings that were active when the plugin loaded, and `/preset` would
 * silently stop applying to graded work.
 */
import { exec as nodeExec } from "node:child_process";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createMutexRegistry } from "./deterministic";
import { tierModel } from "./dispatch";
import type { RouterConfig } from "../router/config";
import type { GateDeps } from "./gate";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GraderRequest {
  tier: string;
  system: string;
  prompt: string;
}

/**
 * Join the text parts of an opencode prompt response. Tolerant of a missing or
 * malformed body by design: every call site is fail-closed, and an empty string
 * reads downstream as "the grader said nothing", which is not a pass.
 */
export function extractAssistantText(res: any): string {
  const parts: any[] = res?.data?.parts ?? [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

export interface VerificationWiring {
  /** Session ids currently running a grader prompt, so hooks can skip them. */
  graderSessions: Set<string>;
  /** Abort then delete a plugin-created child session. Never throws. */
  disposeChildSession(sid: string): Promise<void>;
  /** Run one grader turn, parented to the caller's session when given. */
  dispatchGrader(
    req: GraderRequest,
    parentSessionID?: string,
  ): Promise<{ sessionID: string; text: string }>;
  /** Deps for the acceptance gate; graders are parented to parentSessionID. */
  buildGateDeps(parentSessionID?: string): GateDeps;
}

export function createVerificationWiring(deps: {
  client: any;
  /** Project root; relative paths in checks resolve against it. */
  directory: string;
  getConfig: () => RouterConfig;
}): VerificationWiring {
  const { client, directory, getConfig } = deps;
  const graderSessions = new Set<string>();
  const mutex = createMutexRegistry();

  const execSeam = (
    command: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult> =>
    new Promise((resolve) => {
      try {
        nodeExec(
          command,
          {
            cwd: opts?.cwd ?? directory,
            timeout: opts?.timeoutMs ?? 120000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          },
          (err: any, stdout: any, stderr: any) => {
            const timedOut = !!(err && err.killed && err.signal === "SIGTERM");
            const code =
              err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({
              code,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              timedOut,
            });
          },
        );
      } catch {
        resolve({ code: 1, stdout: "", stderr: "exec failed", timedOut: false });
      }
    });

  const fsSeam = {
    async fileExists(p: string): Promise<boolean> {
      try {
        await access(isAbsolute(p) ? p : join(directory, p));
        return true;
      } catch {
        return false;
      }
    },
    async readFile(p: string): Promise<string> {
      return await fsReadFile(isAbsolute(p) ? p : join(directory, p), "utf-8");
    },
  };

  // Best-effort disposal of a plugin-created child session: abort any in-flight
  // work, then delete it so it does not linger forever as a top-level session in
  // the TUI. Fail-soft by contract — never throws, so it is safe to call from a
  // finally without masking the original error.
  const disposeChildSession = async (sid: string): Promise<void> => {
    try {
      await client.session.abort({ path: { id: sid } });
    } catch {
      // best-effort: the session may already have completed or been removed
    }
    try {
      await client.session.delete({ path: { id: sid } });
    } catch {
      // best-effort: cleanup must never break the run
    }
  };

  const dispatchGrader = async (
    req: GraderRequest,
    parentSessionID?: string,
  ): Promise<{ sessionID: string; text: string }> => {
    const created: any = await client.session.create({
      body: { ...(parentSessionID ? { parentID: parentSessionID } : {}) },
    });
    const sid: string | undefined = created?.data?.id;
    if (!sid) return { sessionID: "", text: "" };
    graderSessions.add(sid);
    try {
      const model = tierModel(getConfig(), req.tier) ?? undefined;
      const res: any = await client.session.prompt({
        path: { id: sid },
        body: {
          ...(model ? { model } : {}),
          system: req.system,
          parts: [{ type: "text", text: req.prompt }],
        },
      });
      return { sessionID: sid, text: extractAssistantText(res) };
    } finally {
      graderSessions.delete(sid);
      await disposeChildSession(sid);
    }
  };

  const buildGateDeps = (parentSessionID?: string): GateDeps => {
    const cfg = getConfig();
    return {
      deterministic: {
        exec: execSeam,
        fs: fsSeam,
        cwd: directory,
        mutex,
      },
      checker: {
        dispatchGrader: (req: GraderRequest) => dispatchGrader(req, parentSessionID),
        ladder: ["fast", "medium", "heavy"],
        minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
      },
      require: cfg.enforcement?.verify?.require,
    };
  };

  return {
    graderSessions,
    disposeChildSession,
    dispatchGrader,
    buildGateDeps,
  };
}
