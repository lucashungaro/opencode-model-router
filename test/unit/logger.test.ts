import { describe, it, expect, vi, afterEach } from "vitest";
import { createPluginLogger, LOG_SERVICE } from "../../src/router/logger";

type LogReq = {
  body: {
    service: string;
    level: string;
    message: string;
    extra?: Record<string, unknown>;
  };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createPluginLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to the opencode log with a service tag and level", () => {
    const log = vi.fn(() => Promise.resolve());
    createPluginLogger({ app: { log } }).warn("something drifted");
    expect(log).toHaveBeenCalledWith({
      body: { service: LOG_SERVICE, level: "warn", message: "something drifted" },
    });
  });

  it("passes structured extra through when given", () => {
    const log = vi.fn((_req: LogReq) => Promise.resolve());
    createPluginLogger({ app: { log } }).warn("m", { pattern: "opus-4-8" });
    expect(log.mock.calls[0]![0].body.extra).toEqual({ pattern: "opus-4-8" });
  });

  it("omits extra entirely rather than sending an empty object", () => {
    const log = vi.fn((_req: LogReq) => Promise.resolve());
    createPluginLogger({ app: { log } }).warn("m");
    expect(log.mock.calls[0]![0].body).not.toHaveProperty("extra");
  });

  // The whole point: nothing reaches stderr, because stderr paints over the TUI.
  it("does not touch the console on the happy path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createPluginLogger({ app: { log: () => Promise.resolve() } }).warn("m");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the console when the client cannot log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const client of [undefined, {}, { app: {} }, { app: { log: 42 } }]) {
      createPluginLogger(client).warn("m");
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  // A diagnostic that cannot be delivered is still a diagnostic worth seeing.
  it("falls back when the post rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createPluginLogger({ app: { log: () => Promise.reject(new Error("down")) } }).warn("m");
    await flush();
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  it("falls back when the call throws synchronously", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createPluginLogger({
      app: { log: () => { throw new Error("boom"); } },
    }).warn("m");
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  // Fire-and-forget: a hook must never block on a warning, and a slow or
  // rejected post must never surface as an unhandled rejection.
  it("returns without awaiting the post", () => {
    let settled = false;
    const log = () => new Promise((r) => setTimeout(() => { settled = true; r(undefined); }, 20));
    createPluginLogger({ app: { log } }).warn("m");
    expect(settled).toBe(false);
  });

  it("tolerates a non-promise return", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => createPluginLogger({ app: { log: () => undefined } }).warn("m")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
