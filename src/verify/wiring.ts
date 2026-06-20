// ---------------------------------------------------------------------------
// src/verify/wiring.ts — Layer-2 verification wiring.
//
// Bundles the live adapters the acceptance gate needs (shell exec, fs reads,
// an independent grader dispatched in a fresh session, and the verify mutex)
// behind a single factory, so index.ts stays focused on hook orchestration.
//
// This is the one impure corner of the verify/ tree: it touches the OS (exec,
// fs, tmp) and the opencode client. The decision logic it feeds (gate.ts,
// checker.ts, deterministic.ts) stays pure.
// ---------------------------------------------------------------------------

import { exec as nodeExec } from "node:child_process";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { RouterConfig } from "../router/config";
import type { GateDeps } from "./gate";
import { tierModel } from "./dispatch";
import { createMutexRegistry } from "./deterministic";
import { formatLadderScorecard } from "../escalate/ladder";

/** Concatenate the text parts of a `session.prompt` response into one string. */
export function extractAssistantText(res: any): string {
  const parts: any[] = res?.data?.parts ?? [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

export interface VerificationWiring {
  /** Build the (config-current) deps for one acceptance-gate call. */
  buildGateDeps(): GateDeps;
  /** Append a best-effort, secret-free delegate scorecard line to a temp log. */
  dumpDelegateScorecard(
    sid: string,
    st: Parameters<typeof formatLadderScorecard>[0],
    accepted: boolean,
    method: string,
  ): void;
  /** True for sessions the grader created (used to force temperature 0). */
  isGraderSession(sessionID: string): boolean;
}

export function createVerificationWiring(deps: {
  client: any;
  directory: string;
  getConfig: () => RouterConfig;
}): VerificationWiring {
  const { client, directory, getConfig } = deps;

  // Sessions spun up for grading — tracked so the chat.params hook can pin them
  // to temperature 0 for deterministic verdicts.
  const graderSessions = new Set<string>();
  const verifyMutex = createMutexRegistry();

  // Live adapters (fail-closed at every call site).
  const execSeam = (
    command: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> =>
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

  // Independent grader: runs in a fresh session (producer != grader) and is
  // removed from the tracking set as soon as the prompt returns.
  const dispatchGrader = async (req: {
    tier: string;
    system: string;
    prompt: string;
  }): Promise<{ sessionID: string; text: string }> => {
    const created: any = await client.session.create({});
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
    }
  };

  const buildGateDeps = (): GateDeps => {
    const cfg = getConfig();
    return {
      deterministic: {
        exec: execSeam,
        fs: fsSeam,
        cwd: directory,
        mutex: verifyMutex,
      },
      checker: {
        dispatchGrader,
        ladder: ["fast", "medium", "heavy"],
        minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
      },
      require: cfg.enforcement?.verify?.require,
    };
  };

  const dumpDelegateScorecard = (
    sid: string,
    st: Parameters<typeof formatLadderScorecard>[0],
    accepted: boolean,
    method: string,
  ): void => {
    try {
      const line = formatLadderScorecard(st, accepted, method);
      const dir = join(tmpdir(), "opencode-model-router-trajectory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sid}.delegate.log`), line + "\n", { flag: "a" });
    } catch {
      // best-effort only
    }
  };

  return {
    buildGateDeps,
    dumpDelegateScorecard,
    isGraderSession: (sessionID: string) => graderSessions.has(sessionID),
  };
}
