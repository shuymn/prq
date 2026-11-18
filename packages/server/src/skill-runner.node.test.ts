// The container's skill runner (container/prq-skill-run.py) run for real with the machine's python3 (3.12 or later)
// in fresh directories of the OS temp directory, only its user switch faked (src/test/skill-runner-wrapper.py), with
// frames from the Workspace's encoder (skill-runner.ts). The runner signals only its own unreaped children, so it cannot
// reach this process or any other of the test user; a sibling process started beside each run checks that it lives on.
// Linux only: the child subreaper and /proc/self/task/<tid>/children are Linux's. The ownership a distinct user gives,
// and the reset cleanup, which signals root's processes, are the owner's real-container check's (check:skills).

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_PATH_BYTES } from "@prq/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { type FrameFile, type FrameHeader, scriptFrame, splitTrailer, type Trailer } from "./skill-runner.ts";

const RUNNER = fileURLToPath(new URL("../container/prq-skill-run.py", import.meta.url));
const WRAPPER = fileURLToPath(new URL("./test/skill-runner-wrapper.py", import.meta.url));
const NAME = "polish";
const encoder = new TextEncoder();

// The script every case runs: it records that it ran, then acts as its mode says.
const SCRIPT = `import hashlib, os, stat, subprocess, sys, time
record, marker, mode, *rest = sys.argv[1:]
def note(name, text):
    with open(os.path.join(record, name), "w") as file:
        file.write(text)
note("ran", str(os.getpid()))
note("marker", str(os.path.exists(marker)))
note("cwd", os.getcwd())
if mode == "echo":
    data = sys.stdin.buffer.read()
    with open(os.path.join(record, "input"), "wb") as file:
        file.write(data)
    print(hashlib.sha256(data).hexdigest())
    print("to stderr", file=sys.stderr)
elif mode == "fail":
    sys.stderr.write("the last line without a newline")
    sys.exit(3)
elif mode == "sleep":
    time.sleep(float(rest[0]))
elif mode == "wait":
    while not os.path.exists(rest[0]):
        time.sleep(0.02)
elif mode == "orphan":
    grandchild = "import os, sys, time; time.sleep(0.3); open(sys.argv[1], 'w').write(str(os.getppid()) + ' ' + str(os.getpid())); time.sleep(60)"
    child = "import subprocess, sys; subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]], start_new_session=True)"
    subprocess.run([sys.executable, "-c", child, grandchild, os.path.join(record, "parent")], check=True)
    time.sleep(float(rest[0]))
elif mode == "survivor":
    survivor = subprocess.Popen(["sleep", "60"], start_new_session=True)
    note("survivor", str(survivor.pid))
    time.sleep(60)
elif mode == "survey":
    # Everything under the root the script's user could read: entries others may read, and its own scratch.
    scratch = os.getcwd()
    def readable(path, mode, need):
        return path == scratch or path.startswith(scratch + "/") or mode & need == need
    lines = []
    for top, dirs, files in os.walk(rest[0]):
        for name in sorted(dirs + files):
            path = os.path.join(top, name)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode):
                lines.append(path + " -> " + os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                lines.append(path + ("/" if readable(path, info.st_mode, 0o005) else " (closed)"))
            elif readable(path, info.st_mode, 0o004):
                with open(path, "rb") as file:
                    lines.append(path + " " + file.read().decode("utf-8", "replace"))
            else:
                lines.append(path + " (closed)")
        dirs[:] = [name for name in dirs if readable(os.path.join(top, name), os.lstat(os.path.join(top, name)).st_mode, 0o005)]
    note("survey", "\\n".join(lines))
`;

// A path under references/ of exactly `bytes` UTF-8 bytes, most of them three-byte characters.
function multibytePath(bytes: number): string {
  const dir = "references/";
  const kana = Math.floor((bytes - dir.length) / 3);
  return `${dir}${"あ".repeat(kana)}${"x".repeat(bytes - dir.length - kana * 3)}`;
}

function bundle(extra: Record<string, string> = {}): FrameFile[] {
  const files: Record<string, string> = { "SKILL.md": "---\nname: polish\n---\n", "references/a.md": "a\n", ...extra };
  return [
    ...Object.entries(files).map(([path, text]) => ({ path, mode: "100644" as const, content: encoder.encode(text) })),
    { path: "scripts/run.py", mode: "100755" as const, content: encoder.encode(SCRIPT) },
  ].toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

type Fixture = { root: string; record: string; token: string };
const roots: string[] = [];
const siblings: ChildProcess[] = [];

async function newFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "prq-runner-"));
  roots.push(base);
  const root = join(base, "workspace");
  const record = join(base, "record");
  await mkdir(join(root, "repo", ".git"), { recursive: true });
  await mkdir(record);
  const token = randomBytes(16).toString("hex");
  await writeFile(join(root, "repo", ".git", "prq-ready"), token);
  return { root, record, token };
}

afterEach(async () => {
  for (const sibling of siblings.splice(0)) {
    // The sibling lived through the case: the runner never reached it.
    const lived = sibling.exitCode === null && sibling.signalCode === null;
    sibling.kill("SIGKILL");
    if (!lived) {
      throw new Error(`a sibling process ended during the case (${sibling.exitCode ?? sibling.signalCode})`);
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function header(fixture: Fixture, overrides: Partial<FrameHeader> = {}): FrameHeader {
  return {
    nonce: randomBytes(16).toString("hex"),
    seq: 1,
    gen: 1,
    first: true,
    token: fixture.token,
    leftMs: 60_000,
    ...overrides,
  };
}

function argv(fixture: Fixture, mode: string, ...rest: string[]): string[] {
  const script = join(fixture.root, "skills", NAME, "scripts", "run.py");
  return ["python3", script, fixture.record, join(fixture.root, ".prq", "running"), mode, ...rest];
}

type Ended = { trailer: Trailer | null; stderr: string; stdout: string; code: number | null; ms: number };

// One runner process. `write` feeds its stdin (the whole frame, then the end, by default).
function start(
  fixture: Fixture,
  command: string[],
  write: (stdin: NodeJS.WritableStream) => void | Promise<void>,
  nonce: string,
  env: Record<string, string> = {},
): { pid: number; ended: Promise<Ended>; exited: Promise<void>; process: ChildProcess } {
  const sibling = spawn("sleep", ["300"], { stdio: "ignore" });
  siblings.push(sibling);
  const started = performance.now();
  const child = spawn(
    "python3",
    ["-I", "-S", WRAPPER, RUNNER, "--root", fixture.root, "--user", "skill", NAME, "--", ...command],
    {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.on("error", () => undefined);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const ended = new Promise<Ended>((resolve) => {
    child.on("close", (code) => {
      const split = splitTrailer(stderr, nonce);
      resolve({ ...split, stdout, code, ms: performance.now() - started });
    });
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  void write(child.stdin);
  return { pid: child.pid ?? 0, ended, exited, process: child };
}

function frameWriter(parts: Uint8Array[], end = true) {
  return (stdin: NodeJS.WritableStream) => {
    for (const part of parts) {
      stdin.write(part);
    }
    if (end) {
      stdin.end();
    }
  };
}

function run(
  fixture: Fixture,
  command: string[],
  frame: FrameHeader,
  {
    files = bundle(),
    input = new Uint8Array(),
    env = {},
  }: { files?: FrameFile[]; input?: Uint8Array; env?: Record<string, string> } = {},
): Promise<Ended> {
  return start(fixture, command, frameWriter(scriptFrame(frame, files, input)), frame.nonce, env).ended;
}

// Every path under the runner's root but the checkout, with its kind, mode and content: what a refusal leaves as it was.
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir).catch((): string[] => [])).toSorted()) {
      const path = join(dir, entry);
      const relative = `${prefix}${entry}`;
      if (relative === "repo") {
        continue;
      }
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        out.push(`${relative} -> ${await readlink(path)}`);
      } else if (info.isDirectory()) {
        out.push(`${relative}/ ${(info.mode & 0o7777).toString(8)}`);
        await walk(path, `${relative}/`);
      } else {
        const hash = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        out.push(`${relative} ${(info.mode & 0o7777).toString(8)} ${hash}`);
      }
    }
  };
  await walk(root, "");
  return out;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The installed skill's files, as the runner extracted them: each path with its mode and bytes.
async function installed(root: string): Promise<string[]> {
  const dir = join(root, "skills", NAME);
  const out: string[] = [];
  const walk = async (path: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(path)).toSorted()) {
      const full = join(path, entry);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full, `${prefix}${entry}/`);
      } else {
        out.push(`${prefix}${entry} ${(info.mode & 0o777).toString(8)} ${(await readFile(full)).toString("base64")}`);
      }
    }
  };
  await walk(dir, "");
  return out;
}

function expected(files: FrameFile[]): string[] {
  return files
    .map(
      (file) =>
        `${file.path} ${file.mode === "100755" ? "755" : "644"} ${Buffer.from(file.content).toString("base64")}`,
    )
    .toSorted();
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what}: not within 10 s`);
}

// A ustar numeric field: octal digits filling all but its last byte, then NUL.
function octal(value: number, size: number): string {
  return `${value.toString(8).padStart(size - 1, "0")}\0`;
}

// A ustar archive written field by field, for members the Workspace's encoder never writes: links, devices, an
// absolute path, a path with a prefix field, a setuid mode.
function rawTar(
  entries: { name: string; type: string; mode: number; data?: string; link?: string; prefix?: string }[],
) {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = encoder.encode(entry.data ?? "");
    const block = new Uint8Array(512);
    const put = (text: string, offset: number, size: number) =>
      block.set(encoder.encode(text).subarray(0, size), offset);
    put(entry.name, 0, 100);
    put(octal(entry.mode, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(data.byteLength, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    put("        ", 148, 8);
    put(entry.type, 156, 1);
    put(entry.link ?? "", 157, 100);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    put(entry.prefix ?? "", 345, 155);
    const sum = block.reduce((total, byte) => total + byte, 0);
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(block);
    if (data.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

// A frame whose archive is given as bytes.
function rawFrame(frame: FrameHeader, archive: Uint8Array, input = new Uint8Array()): Uint8Array[] {
  const line = JSON.stringify({ ...frame, archiveBytes: archive.byteLength, inputBytes: input.byteLength });
  return [encoder.encode(`${line}\n`), archive, input];
}

describe.skipIf(process.platform !== "linux")("the skill runner", () => {
  it("extracts the skill, runs the script as its user in the scratch with the exact input, and ends with its trailer", async () => {
    const f = await newFixture();
    // With a member whose path is SKILL_PATH_BYTES long in UTF-8, the most a skill's path may be.
    const files = bundle({ [multibytePath(SKILL_PATH_BYTES)]: "at the limit\n" });
    const input = randomBytes(100_000);
    const frame = header(f);

    const ended = await run(f, argv(f, "echo"), frame, { files, input });

    expect(ended.trailer).toEqual({ scratch: "new", end: { kind: "exit", code: 0 }, clean: true });
    expect(ended.stdout).toBe(`${createHash("sha256").update(input).digest("hex")}\n`);
    expect(ended.stderr).toBe("to stderr\n");
    expect(Buffer.compare(await readFile(join(f.record, "input")), input)).toBe(0);
    expect(await installed(f.root)).toEqual(expected(files));
    expect(await readFile(join(f.record, "cwd"), "utf8")).toBe(join(f.root, "scratch", "1"));
    expect(await readFile(join(f.record, "marker"), "utf8")).toBe("True");
    expect(await exists(join(f.root, ".prq", "running"))).toBe(false);
    expect(JSON.parse(await readFile(join(f.root, ".prq", "state.json"), "utf8"))).toEqual({ seq: 1, gen: 1 });
  });

  it("keeps a script's stderr as written, its last line without a newline included, and the trailer on its own line", async () => {
    const f = await newFixture();
    const frame = header(f);

    const ended = await run(f, argv(f, "fail"), frame);

    expect(ended.trailer).toEqual({ scratch: "new", end: { kind: "exit", code: 3 }, clean: true });
    expect(ended.stderr).toBe("the last line without a newline");
    expect(splitTrailer(`${ended.stderr}\nfffffff scratch=new end=exit:0 clean=1\n`, frame.nonce).trailer).toBeNull();
  });

  it("keeps the scratch for the turn's next frame of the same generation, and makes it again for another", async () => {
    const f = await newFixture();
    await run(f, argv(f, "echo"), header(f));
    await writeFile(join(f.root, "scratch", "1", "state"), "kept");

    const kept = await run(f, argv(f, "echo"), header(f, { first: false }));
    expect(kept.trailer?.scratch).toBe("kept");
    expect(await readFile(join(f.root, "scratch", "1", "state"), "utf8")).toBe("kept");

    const lost = await run(f, argv(f, "echo"), header(f, { first: false, gen: 2 }));
    expect(lost.trailer?.scratch).toBe("lost");
    expect(await exists(join(f.root, "scratch", "1", "state"))).toBe(false);

    await mkdir(join(f.root, "scratch", "7"));
    const next = await run(f, argv(f, "echo"), header(f, { seq: 2 }));
    expect(next.trailer?.scratch).toBe("new");
    expect(await readdir(join(f.root, "scratch"))).toEqual(["2"]);
  });

  it("removes every other turn's scratch on a newer turn's frame that is not its first, saying the scratch was lost", async () => {
    const f = await newFixture();
    expect((await run(f, argv(f, "echo"), header(f))).trailer?.scratch).toBe("new");
    expect(await readdir(join(f.root, "scratch"))).toEqual(["1"]);
    // Turn 2's first attempt never reached the runner's scratch; its retry comes with the raised generation.
    const retry = await run(f, argv(f, "echo"), header(f, { seq: 2, gen: 2, first: false }));
    expect(retry.trailer).toMatchObject({ scratch: "lost", end: { kind: "exit", code: 0 } });
    expect(await readdir(join(f.root, "scratch"))).toEqual(["2"]);
  });

  it("leaves the run's nonce nowhere the script's user can read under the root", async () => {
    const f = await newFixture();
    const frame = header(f);
    const ended = await run(f, argv(f, "survey", f.root), frame);
    expect(ended.trailer?.end).toEqual({ kind: "exit", code: 0 });
    const survey = await readFile(join(f.record, "survey"), "utf8");
    // It read the link to the installed skill, its files and the scratch; the runner's own directory is closed to it.
    expect(survey).toContain(`${join(f.root, "skills", NAME)} -> `);
    expect(survey).toContain(`${join(f.root, "skills")}/`);
    expect(survey).toContain(`${join(f.root, ".prq")} (closed)`);
    expect(survey).not.toContain(frame.nonce);
  });

  it("ends a frame shorter, longer or later than declared as failed:frame, touching nothing and running nothing", async () => {
    const f = await newFixture();
    const frame = header(f);
    const parts = scriptFrame(frame, bundle(), encoder.encode("input"));
    const [line = new Uint8Array(), archive = new Uint8Array(), input = new Uint8Array()] = parts;
    const cases: [string, (stdin: NodeJS.WritableStream) => void, Record<string, string>][] = [
      ["an archive shorter than declared", frameWriter([line, archive.subarray(0, archive.byteLength - 10)]), {}],
      ["an input shorter than declared", frameWriter([line, archive, input.subarray(0, 2)]), {}],
      ["bytes beyond the declared input", frameWriter([line, archive, input, encoder.encode("x")]), {}],
      ["a stdin open past the start bound", frameWriter([line, archive, input], false), { PRQ_START_S: "1" }],
      ["no frame at all", frameWriter([]), {}],
    ];
    const before = await snapshot(f.root);
    for (const [what, write, env] of cases) {
      const runner = start(f, argv(f, "echo"), write, frame.nonce, env);
      const ended = await runner.ended;
      runner.process.stdin?.destroy();
      expect({ what, end: ended.trailer?.end ?? splitTrailer(ended.stderr, "-").trailer?.end }).toEqual({
        what,
        end: { kind: "failed", reason: "frame", detail: null },
      });
      expect(ended.ms).toBeLessThan(5000);
    }
    expect(await snapshot(f.root)).toEqual(before);
    expect(await exists(join(f.record, "ran"))).toBe(false);
  });

  it("refuses under its lock, before any shared write, a left marker, a passed deadline, an older turn or generation, and a checkout not the frame's", async () => {
    const f = await newFixture();
    await run(f, argv(f, "echo"), header(f, { seq: 5, gen: 2 }));
    await rm(join(f.record, "ran"));
    const refusals: [string, FrameHeader, string, () => Promise<void>, () => Promise<void>][] = [
      [
        "unclean",
        header(f, { seq: 6 }),
        "unclean",
        () => writeFile(join(f.root, ".prq", "running"), "1 x\n"),
        () => rm(join(f.root, ".prq", "running")),
      ],
      ["expired", header(f, { seq: 6, leftMs: 0 }), "expired", async () => undefined, async () => undefined],
      ["stale turn", header(f, { seq: 4 }), "stale-turn", async () => undefined, async () => undefined],
      [
        "an older generation",
        header(f, { seq: 5, gen: 1, first: false }),
        "stale-scratch",
        async () => undefined,
        async () => undefined,
      ],
      [
        "an equal generation on a first frame",
        header(f, { seq: 5, gen: 2 }),
        "stale-scratch",
        async () => undefined,
        async () => undefined,
      ],
      [
        "another token",
        header(f, { seq: 6, token: "abcdef" }),
        "checkout",
        async () => undefined,
        async () => undefined,
      ],
      [
        "no token file",
        header(f, { seq: 6 }),
        "checkout",
        () => rm(join(f.root, "repo", ".git", "prq-ready")),
        () => writeFile(join(f.root, "repo", ".git", "prq-ready"), f.token),
      ],
    ];
    for (const [what, frame, reason, set, unset] of refusals) {
      await set();
      const before = await snapshot(f.root);
      const ended = await run(f, argv(f, "echo"), frame);
      expect({ what, trailer: ended.trailer }).toEqual({
        what,
        trailer: { scratch: null, end: { kind: "failed", reason, detail: null }, clean: true },
      });
      expect(await snapshot(f.root)).toEqual(before);
      await unset();
    }
    expect(await exists(join(f.record, "ran"))).toBe(false);
  });

  it("makes only its own directory and lock when it refuses a complete frame on a fresh root", async () => {
    const f = await newFixture();
    const before = await snapshot(f.root);
    const ended = await run(f, argv(f, "echo"), header(f, { token: "abcdef" }));
    expect(ended.trailer?.end).toEqual({ kind: "failed", reason: "checkout", detail: null });
    const empty = createHash("sha256").update("").digest("hex");
    expect(await snapshot(f.root)).toEqual([".prq/ 700", `.prq/lock 600 ${empty}`, ...before]);
    expect(await exists(join(f.record, "ran"))).toBe(false);
  });

  it("refuses a launch whose deadline passed while its input was still arriving", async () => {
    const f = await newFixture();
    await run(f, argv(f, "echo"), header(f));
    await rm(join(f.record, "ran"));
    const frame = header(f, { seq: 2, leftMs: 500 });
    const [line = new Uint8Array(), archive = new Uint8Array(), input = new Uint8Array()] = scriptFrame(
      frame,
      bundle(),
      encoder.encode("late"),
    );
    const before = await snapshot(f.root);

    const runner = start(
      f,
      argv(f, "echo"),
      async (stdin) => {
        stdin.write(line);
        stdin.write(archive);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        stdin.write(input);
        stdin.end();
      },
      frame.nonce,
    );

    expect((await runner.ended).trailer?.end).toEqual({ kind: "failed", reason: "expired", detail: null });
    expect(await snapshot(f.root)).toEqual(before);
    expect(await exists(join(f.record, "ran"))).toBe(false);
  });

  it("answers busy at once while another runner holds the lock", async () => {
    const f = await newFixture();
    const release = join(f.record, "release");
    const holding = run(f, argv(f, "wait", release), header(f));
    await until(() => exists(join(f.record, "ran")), "the first script");
    await rm(join(f.record, "ran"));

    const second = await run(f, argv(f, "echo"), header(f, { first: false }));

    expect(second.trailer).toEqual({ scratch: null, end: { kind: "busy" }, clean: true });
    expect(second.ms).toBeLessThan(2000);
    expect(await exists(join(f.record, "ran"))).toBe(false);
    await writeFile(release, "");
    expect((await holding).trailer?.end).toEqual({ kind: "exit", code: 0 });
  });

  it("refuses an archive member other than a regular file or a directory within the path rules, extracting nothing", async () => {
    const f = await newFixture();
    const files = bundle();
    await run(f, argv(f, "echo"), header(f), { files });
    const members = [
      { name: "link", type: "2", mode: 0o777, link: "/etc/passwd" },
      { name: "hard", type: "1", mode: 0o644, link: "SKILL.md" },
      { name: "device", type: "3", mode: 0o644 },
      { name: "/absolute", type: "0", mode: 0o644, data: "x" },
      { name: "a/../../escape", type: "0", mode: 0o644, data: "x" },
      // One byte over SKILL_PATH_BYTES, through the ustar prefix field.
      {
        name: multibytePath(SKILL_PATH_BYTES + 1).slice("references/".length),
        type: "0",
        mode: 0o644,
        data: "x",
        prefix: "references",
      },
      { name: "setuid", type: "0", mode: 0o4755, data: "x" },
    ];
    let seq = 1;
    for (const member of members) {
      seq += 1;
      const archive = rawTar([{ name: "SKILL.md", type: "0", mode: 0o644, data: "---\n" }, member]);
      const frame = header(f, { seq });
      const runner = start(f, argv(f, "echo"), frameWriter(rawFrame(frame, archive)), frame.nonce);
      const ended = await runner.ended;
      expect({ member: member.name, end: ended.trailer?.end.kind, reason: ended.trailer?.end }).toMatchObject({
        member: member.name,
        end: "failed",
        reason: { reason: "member" },
      });
      expect(await installed(f.root)).toEqual(expected(files));
    }
    expect((await readdir(join(f.root, "skills"))).filter((entry) => entry.startsWith(".stage-"))).toHaveLength(1);
  });

  it("ends a script over its bound as timeout, its processes reaped, within the reaping bound", async () => {
    const f = await newFixture();

    const ended = await run(f, argv(f, "sleep", "30"), header(f), { env: { PRQ_SCRIPT_S: "1" } });

    expect(ended.trailer).toEqual({ scratch: "new", end: { kind: "timeout" }, clean: true });
    expect(ended.ms).toBeLessThan(7000);
    expect(alive(Number(await readFile(join(f.record, "ran"), "utf8")))).toBe(false);
    expect(await exists(join(f.root, ".prq", "running"))).toBe(false);
  });

  it("adopts an orphaned grandchild as the subreaper and reaps it before reporting clean", async () => {
    const f = await newFixture();
    const frame = header(f);

    const runner = start(
      f,
      argv(f, "orphan", "1"),
      frameWriter(scriptFrame(frame, bundle(), new Uint8Array())),
      frame.nonce,
    );
    // Read before the runner's ending: a grandchild no subreaper adopted keeps the runner's streams open.
    const record = join(f.record, "parent");
    await until(async () => (await exists(record)) && (await readFile(record, "utf8")).includes(" "), "the record");
    const [parent = "", grandchild = ""] = (await readFile(record, "utf8")).split(" ");
    expect(Number(parent)).toBe(runner.pid);
    const ended = await runner.ended;
    expect(ended.trailer).toEqual({ scratch: "new", end: { kind: "exit", code: 0 }, clean: true });
    expect(alive(Number(grandchild))).toBe(false);
  });

  it("leaves its marker when killed with a child alive, and the next runner refuses before spawning", async () => {
    const f = await newFixture();
    const frame = header(f);
    const runner = start(
      f,
      argv(f, "survivor"),
      frameWriter(scriptFrame(frame, bundle(), new Uint8Array())),
      frame.nonce,
    );
    await until(() => exists(join(f.record, "survivor")), "the survivor");
    const survivor = Number(await readFile(join(f.record, "survivor"), "utf8"));
    const script = Number(await readFile(join(f.record, "ran"), "utf8"));
    runner.process.kill("SIGKILL");
    await runner.exited;
    await rm(join(f.record, "ran"));
    try {
      expect(alive(survivor)).toBe(true);
      expect(await exists(join(f.root, ".prq", "running"))).toBe(true);

      const next = await run(f, argv(f, "echo"), header(f, { first: false }));

      expect(next.trailer?.end).toEqual({ kind: "failed", reason: "unclean", detail: null });
      expect(await exists(join(f.record, "ran"))).toBe(false);
    } finally {
      process.kill(survivor, "SIGKILL");
      process.kill(script, "SIGKILL");
    }
  });

  it("extracts into a fresh staging directory published by one rename, leaving no other directory and reusing none", async () => {
    const f = await newFixture();
    const hold = join(f.record, "held");
    const frame = header(f);
    const a = start(
      f,
      argv(f, "echo"),
      frameWriter(scriptFrame(frame, bundle({ "references/only-in-a.md": "a's\n" }), new Uint8Array())),
      frame.nonce,
      { PRQ_TEST_HOLD_EXTRACT: hold },
    );
    await until(() => exists(hold), "A's extraction");
    a.process.kill("SIGKILL");
    await a.ended;
    expect((await readdir(join(f.root, "skills"))).filter((entry) => entry.startsWith(".stage-"))).toHaveLength(1);

    // The skills directory holds the link and the one staging directory it names, a fresh one each run.
    const published = async () => {
      const target = await readlink(join(f.root, "skills", NAME));
      expect(target).toMatch(/^\.stage-[0-9a-f]{32}$/);
      expect(new Set(await readdir(join(f.root, "skills")))).toEqual(new Set([target, NAME]));
      return target;
    };
    const files = bundle();
    const b = header(f, { seq: 2 });
    expect((await run(f, argv(f, "echo"), b, { files })).trailer?.end).toEqual({ kind: "exit", code: 0 });
    expect(await installed(f.root)).toEqual(expected(files));
    const first = await published();

    // A leftover staging directory planted with a file of its own: removed, never published.
    await mkdir(join(f.root, "skills", ".stage-planted"));
    await writeFile(join(f.root, "skills", ".stage-planted", "planted"), "x");
    await chmod(join(f.root, "skills", ".stage-planted"), 0o755);
    expect((await run(f, argv(f, "echo"), header(f, { seq: 3 }), { files })).trailer?.end).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(await installed(f.root)).toEqual(expected(files));
    expect(await published()).not.toBe(first);
  });
});
