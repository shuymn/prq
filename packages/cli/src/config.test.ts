import { describe, expect, it } from "vitest";

import { cloneRoots, readConfig } from "./config.ts";
import { CliError } from "./errors.ts";

const system = { hostname: "host-name", homedir: "/home/someone" };
const valid = {
  PRQ_URL: "https://prq.example.com",
  PRQ_ACCESS_CLIENT_ID: "id.access",
  PRQ_ACCESS_CLIENT_SECRET: "secret",
};

function home(env: Record<string, string>): string {
  return readConfig({ ...valid, ...env }, undefined, system).home;
}

function failure(run: () => unknown): { exitCode: number; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) {
      return { exitCode: error.exitCode, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("readConfig", () => {
  describe("agent ID", () => {
    it("is --agent-id, else PRQ_AGENT_ID, else the host name", () => {
      expect(readConfig({ ...valid, PRQ_AGENT_ID: "env" }, "flag", system).agentId).toBe("flag");
      expect(readConfig({ ...valid, PRQ_AGENT_ID: "env" }, undefined, system).agentId).toBe("env");
      expect(readConfig({ ...valid, PRQ_AGENT_ID: "" }, undefined, system).agentId).toBe("host-name");
      expect(readConfig(valid, undefined, system).agentId).toBe("host-name");
    });

    it.each([
      ["--agent-id", "", undefined, system.hostname],
      ["--agent-id", "has space", undefined, system.hostname],
      ["--agent-id", "x".repeat(129), undefined, system.hostname],
      ["PRQ_AGENT_ID", undefined, "tab\there", system.hostname],
      ["the host name", undefined, undefined, "café.local"],
    ])("refuses an invalid ID from %s with exit 1", (source, flag, env, hostname) => {
      const run = () => readConfig({ ...valid, PRQ_AGENT_ID: env }, flag, { ...system, hostname });
      expect(failure(run)).toEqual({
        exitCode: 1,
        message: `the agent ID from ${source} is not valid (printable ASCII without spaces, at most 128 characters); pass --agent-id`,
      });
    });

    it("takes printable ASCII up to 128 characters, / included", () => {
      expect(readConfig(valid, `a/b:${"x".repeat(124)}`, system).agentId).toHaveLength(128);
    });
  });

  describe("PRQ_URL", () => {
    it.each([
      ["https://prq.example.com", "https://prq.example.com"],
      ["https://prq.example.com/", "https://prq.example.com"],
      ["https://prq.example.com:8443", "https://prq.example.com:8443"],
      ["http://localhost:8787", "http://localhost:8787"],
      ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
      ["http://[::1]:8787", "http://[::1]:8787"],
    ])("takes %s as the origin %s", (value, origin) => {
      expect(readConfig({ ...valid, PRQ_URL: value }, undefined, system).url).toBe(origin);
    });

    it.each([
      [undefined, "PRQ_URL is not set: set it to the Worker's origin (https://<host>)"],
      ["", "PRQ_URL is not set: set it to the Worker's origin (https://<host>)"],
      ["prq.example.com", "PRQ_URL is not a URL"],
      ["http://prq.example.com", "PRQ_URL must use https (http only for localhost, 127.0.0.1 or [::1])"],
      ["http://10.0.0.1:8787", "PRQ_URL must use https (http only for localhost, 127.0.0.1 or [::1])"],
      ["ftp://prq.example.com", "PRQ_URL must use https (http only for localhost, 127.0.0.1 or [::1])"],
      ["https://prq.example.com/cli", "PRQ_URL must be an origin, without credentials, path, query or fragment"],
      ["https://user:pass@prq.example.com", "PRQ_URL must be an origin, without credentials, path, query or fragment"],
      ["https://prq.example.com/?a=1", "PRQ_URL must be an origin, without credentials, path, query or fragment"],
      ["https://prq.example.com/#x", "PRQ_URL must be an origin, without credentials, path, query or fragment"],
    ])("refuses %s with exit 1", (value, message) => {
      expect(failure(() => readConfig({ ...valid, PRQ_URL: value }, undefined, system))).toEqual({
        exitCode: 1,
        message,
      });
    });
  });

  describe("service token", () => {
    it.each([
      ["no client ID", { PRQ_ACCESS_CLIENT_ID: undefined }],
      ["an empty secret", { PRQ_ACCESS_CLIENT_SECRET: "" }],
    ])("refuses %s with exit 3", (_, env) => {
      expect(failure(() => readConfig({ ...valid, ...env }, undefined, system))).toEqual({
        exitCode: 3,
        message: "no service token: set PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET",
      });
    });

    it("refuses a value that cannot be a header with exit 3", () => {
      expect(failure(() => readConfig({ ...valid, PRQ_ACCESS_CLIENT_SECRET: "a\nb" }, undefined, system))).toEqual({
        exitCode: 3,
        message: "PRQ_ACCESS_CLIENT_ID and PRQ_ACCESS_CLIENT_SECRET must be printable ASCII without spaces",
      });
    });
  });

  describe("state root", () => {
    it("is PRQ_HOME, else $XDG_STATE_HOME/prq, else ~/.local/state/prq", () => {
      expect(home({ PRQ_HOME: "/state/prq", XDG_STATE_HOME: "/xdg" })).toBe("/state/prq");
      expect(home({ XDG_STATE_HOME: "/xdg" })).toBe("/xdg/prq");
      expect(home({ XDG_STATE_HOME: "relative" })).toBe("/home/someone/.local/state/prq");
      expect(home({})).toBe("/home/someone/.local/state/prq");
    });

    it("refuses a relative PRQ_HOME with exit 1", () => {
      expect(failure(() => readConfig({ ...valid, PRQ_HOME: "state" }, undefined, system))).toEqual({
        exitCode: 1,
        message: "PRQ_HOME must be an absolute path",
      });
    });
  });

  it("turns the version notice off only for PRQ_VERSION_NOTICE=0", () => {
    expect(readConfig(valid, undefined, system).versionNotice).toBe(true);
    expect(readConfig({ ...valid, PRQ_VERSION_NOTICE: "1" }, undefined, system).versionNotice).toBe(true);
    expect(readConfig({ ...valid, PRQ_VERSION_NOTICE: "0" }, undefined, system).versionNotice).toBe(false);
  });
});

describe("cloneRoots", () => {
  it("splits at ':', skipping empty entries; none when unset", () => {
    expect(cloneRoots("/src/github.com:/work::")).toEqual(["/src/github.com", "/work"]);
    expect(cloneRoots(undefined)).toEqual([]);
    expect(cloneRoots("")).toEqual([]);
  });

  it("refuses a relative entry", () => {
    expect(failure(() => cloneRoots("/src:work"))).toEqual({
      exitCode: 1,
      message: "PRQ_CLONE_ROOTS must list absolute paths, separated by ':'",
    });
  });
});
