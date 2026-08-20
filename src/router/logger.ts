/**
 * Where the plugin's passive warnings go.
 *
 * `console.warn` from a plugin lands on the server process's stderr, which the
 * TUI does not own, so anything written there paints over whatever the terminal
 * was drawing. A user reported exactly that: a preset switch smeared a
 * ~230-character warning across two lines of UI.
 *
 * opencode exposes `POST /log` for this, reachable as `client.app.log`. Entries
 * go to opencode's own log with a service tag instead of into the terminal.
 *
 * Fail-soft by contract. The call is fire-and-forget: a warning is never worth
 * blocking a hook on, and a logging failure must never surface as a plugin
 * error. When the endpoint is unavailable, or the client rejects, the message
 * falls back to console.warn so a diagnostic is never silently dropped.
 */

export interface PluginLogger {
  warn(message: string, extra?: Record<string, unknown>): void;
}

/** The service tag on every entry, so entries are greppable by origin. */
export const LOG_SERVICE = "model-router";

/** Prefix used only on the console fallback, where there is no service field. */
const CONSOLE_PREFIX = `[${LOG_SERVICE}]`;

type LogCapableClient = {
  app?: {
    log?: (req: {
      body: {
        service: string;
        level: "debug" | "info" | "error" | "warn";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => unknown;
  };
};

/**
 * Build a logger over an opencode client. Falls back to the console when the
 * client cannot log, which covers older servers and every unit test that hands
 * the plugin a stub.
 */
export function createPluginLogger(client?: unknown): PluginLogger {
  const log = (client as LogCapableClient | undefined)?.app?.log;

  if (typeof log !== "function") {
    return {
      warn(message) {
        console.warn(`${CONSOLE_PREFIX} ${message}`);
      },
    };
  }

  return {
    warn(message, extra) {
      let result: unknown;
      try {
        result = log({
          body: {
            service: LOG_SERVICE,
            level: "warn",
            message,
            ...(extra ? { extra } : {}),
          },
        });
      } catch {
        // A synchronous throw means the transport is unusable; say it somewhere.
        console.warn(`${CONSOLE_PREFIX} ${message}`);
        return;
      }
      // Fire-and-forget: never await, but never leave a rejection unhandled
      // either, and do not lose the diagnostic when the post fails.
      void Promise.resolve(result).catch(() => {
        console.warn(`${CONSOLE_PREFIX} ${message}`);
      });
    },
  };
}
