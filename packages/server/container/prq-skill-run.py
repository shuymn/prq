"""The runner of a skill script in the workspace container (docs/design.md, Workspace (cloud)).

Root runs it, root-owned in the image at /usr/local/libexec/prq-skill-run, with `python3 -I -S` (no import path from
the environment or the working directory) and the Python standard library only:

    prq-skill-run --root /workspace --user skill <name> -- python3 /workspace/skills/<name>/<path> [<word> ...]
    prq-skill-run --reset-cleanup

A run reads its whole frame from stdin first: a header line (JSON: nonce, seq, gen, first, token, leftMs,
archiveBytes, inputBytes), the tar archive of the skill's files, the script's input, then the end of stdin, all within
RUNNER_START_S. It then takes the runner lock or answers busy, refuses before any shared write (a running marker left
on the disk, its launch deadline passed, an older turn, an older scratch generation or an equal one on a first frame, a
checkout token other than the frame's), prepares the turn's scratch directory, extracts the skill into a fresh staging
directory published by one rename, and runs the script as the unprivileged user for at most PRQ_SCRIPT_S seconds as
the child subreaper, so that every descendant is reparented to it and reaped before the run ends. The last line of its
stderr is the trailer the Workspace reads:

    <nonce> scratch=<new|kept|lost|-> end=<exit:<code>|timeout|busy|failed:<reason>> clean=<1|0>

clean=1 only once waitpid reported no child left. A script cannot write a trailer that counts: the nonce reaches the
runner on its stdin and is written only to the trailer and to the running marker under the runner's own directory,
which no process of the script's user can read; the staging directory and the link it can read are named by another
random id.

--reset-cleanup ends what a reset Workspace's earlier instance may still run of a prepare: root's git, git-*, rm, cat
and sh processes, each opened as a pidfd and checked again before it is signalled through that pidfd, so a recycled
PID is never signalled. It exits 0 when it killed one, 1 when none, 2 when it could not look or signal (no pidfd).
"""

import ctypes
import fcntl
import io
import json
import os
import pwd
import re
import select
import shutil
import signal
import subprocess
import sys
import tarfile
import time

# The whole frame arrives within this many seconds of the runner's start (PRQ_START_S, for tests).
RUNNER_START_S = 30
# Reaping the script's processes ends within this many seconds.
REAP_S = 5
# A path inside a skill, in UTF-8 bytes (SKILL_PATH_BYTES in @prq/protocol).
SKILL_PATH_BYTES = 100
# The frame's bounds: the header line, the archive (a skill is at most 8 MiB in 200 files), the input (100,000
# characters at four bytes each).
HEADER_BYTES = 4096
ARCHIVE_BYTES = 9 * 1024 * 1024
INPUT_BYTES = 400_000
# A skill's name (the Agent Skills specification's form).
SKILL_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
HEX = re.compile(r"[0-9a-f]{1,128}")
PR_SET_CHILD_SUBREAPER = 36
# The processes a prepare starts, by their exact name.
PREPARE_NAMES = re.compile(r"git|git-.*|rm|cat|sh")


class Ended(Exception):
    """How the run ended before its script did: busy, or failed:<reason>."""

    def __init__(self, end):
        super().__init__(end)
        self.end = end


class FrameError(Exception):
    pass


class Frame:
    """The frame on stdin, read with exact counts within a deadline."""

    def __init__(self, fd, deadline):
        self.fd = fd
        self.deadline = deadline
        self.buffer = bytearray()
        self.eof = False

    def _fill(self, want):
        while len(self.buffer) < want and not self.eof:
            left = self.deadline - time.monotonic()
            if left <= 0:
                raise FrameError("the frame was not complete in time")
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                continue
            chunk = os.read(self.fd, max(want - len(self.buffer), 65536))
            if chunk:
                self.buffer += chunk
            else:
                self.eof = True

    def line(self):
        while True:
            end = self.buffer.find(b"\n")
            if end >= 0:
                line = bytes(self.buffer[:end])
                del self.buffer[: end + 1]
                return line
            if len(self.buffer) > HEADER_BYTES or self.eof:
                raise FrameError("no header line")
            self._fill(len(self.buffer) + 1)

    def exact(self, count):
        self._fill(count)
        if len(self.buffer) < count:
            raise FrameError("shorter than declared")
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data

    def end(self):
        self._fill(1)
        if self.buffer:
            raise FrameError("more bytes than declared")


def header_of(line):
    try:
        header = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise FrameError("the header is not JSON") from error
    fields = {
        "nonce": str,
        "seq": int,
        "gen": int,
        "first": bool,
        "token": str,
        "leftMs": int,
        "archiveBytes": int,
        "inputBytes": int,
    }
    if not isinstance(header, dict) or set(header) != set(fields):
        raise FrameError("the header's fields are not the frame's")
    for key, kind in fields.items():
        value = header[key]
        if type(value) is not kind:
            raise FrameError(f"the header's {key} is not a {kind.__name__}")
    if not HEX.fullmatch(header["nonce"]) or not HEX.fullmatch(header["token"]):
        raise FrameError("the nonce or the token is not hex")
    if header["seq"] < 1 or header["gen"] < 1 or header["leftMs"] < 0:
        raise FrameError("the header's numbers are out of range")
    if not 0 <= header["archiveBytes"] <= ARCHIVE_BYTES or not 0 <= header["inputBytes"] <= INPUT_BYTES:
        raise FrameError("a section is larger than a frame holds")
    return header


def path_issue(path):
    """Why a path inside the skill is refused, or None: relative, /-separated, no empty, . or .. segment."""
    if "\0" in path or "\\" in path:
        return True
    if any(segment in ("", ".", "..") for segment in path.split("/")):
        return True
    return len(path.encode("utf-8", "surrogatepass")) > SKILL_PATH_BYTES


def read_state(path):
    try:
        with open(path, encoding="utf-8") as file:
            state = json.load(file)
        return int(state["seq"]), int(state["gen"])
    except FileNotFoundError:
        return None


def write_file(path, text):
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as file:
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def make_root_dir(path, mode):
    os.makedirs(path, mode=mode, exist_ok=True)
    os.chmod(path, mode)


def remove(path):
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)


class Runner:
    def __init__(self, root, user, name, argv):
        self.root = root
        self.user = user
        self.name = name
        self.argv = argv
        self.prq = os.path.join(root, ".prq")
        self.state_path = os.path.join(self.prq, "state.json")
        self.marker = os.path.join(self.prq, "running")
        self.scratch_root = os.path.join(root, "scratch")
        self.skills = os.path.join(root, "skills")
        self.skill_dir = os.path.join(self.skills, name)
        self.token_path = os.path.join(root, "repo", ".git", "prq-ready")
        self.nonce = "-"
        self.scratch = "-"
        self.clean = 1

    def trailer(self, end):
        line = f"\n{self.nonce} scratch={self.scratch} end={end} clean={self.clean}\n"
        try:
            sys.stderr.flush()
        except OSError:
            pass
        try:
            os.write(2, line.encode("utf-8"))
        except OSError:
            pass

    def run(self, started):
        frame = Frame(0, started + float(os.environ.get("PRQ_START_S", RUNNER_START_S)))
        try:
            header = header_of(frame.line())
            # The launch deadline counts from the header's arrival: the Worker and the container share no clock.
            launch_deadline = time.monotonic() + header["leftMs"] / 1000
            self.nonce = header["nonce"]
            archive = frame.exact(header["archiveBytes"])
            stdin = frame.exact(header["inputBytes"])
            frame.end()
        except FrameError as error:
            raise Ended("failed:frame") from error
        script = self.script_path()
        make_root_dir(self.prq, 0o700)
        lock = os.open(os.path.join(self.prq, "lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Ended("busy") from error
            return self.locked(header, launch_deadline, archive, stdin, script)
        finally:
            os.close(lock)

    def script_path(self):
        prefix = f"{self.skill_dir}/"
        if len(self.argv) < 2 or self.argv[0] != "python3" or not self.argv[1].startswith(prefix):
            raise Ended("failed:argv")
        if path_issue(self.argv[1][len(prefix) :]):
            raise Ended("failed:argv")
        return self.argv[1]

    def locked(self, header, launch_deadline, archive, stdin, script):
        # Every refusal comes before any shared write.
        if os.path.lexists(self.marker):
            raise Ended("failed:unclean")
        if time.monotonic() >= launch_deadline:
            raise Ended("failed:expired")
        state = read_state(self.state_path)
        if state is not None:
            seq, gen = state
            if header["seq"] < seq:
                raise Ended("failed:stale-turn")
            if header["seq"] == seq and (header["gen"] < gen or (header["gen"] == gen and header["first"])):
                raise Ended("failed:stale-scratch")
        try:
            with open(self.token_path, encoding="utf-8") as file:
                token = file.read()
        except OSError:
            token = None
        if token != header["token"]:
            raise Ended("failed:checkout")
        members = self.checked_members(archive)
        scratch = self.prepare_scratch(header, state)
        self.extract(archive, members)
        return self.spawn(script, scratch, stdin)

    def checked_members(self, archive):
        try:
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
                members = tar.getmembers()
        except tarfile.TarError as error:
            raise Ended("failed:archive") from error
        for member in members:
            if not (member.isreg() or member.isdir()) or path_issue(member.name) or member.mode & ~0o755:
                raise Ended(f"failed:member {json.dumps(member.name)[:300]}")
        return members

    def prepare_scratch(self, header, state):
        user = pwd.getpwnam(self.user)
        make_root_dir(self.scratch_root, 0o755)
        directory = os.path.join(self.scratch_root, str(header["seq"]))
        # A turn's first frame, or any frame of a turn newer than the one recorded (its first may never have got
        # here): every other turn's scratch goes, since all of them belong to the same user.
        if header["first"] or state is None or header["seq"] > state[0]:
            for entry in os.listdir(self.scratch_root):
                remove(os.path.join(self.scratch_root, entry))
            self.scratch = "new" if header["first"] else "lost"
        elif state == (header["seq"], header["gen"]) and os.path.isdir(directory):
            self.scratch = "kept"
        else:
            remove(directory)
            self.scratch = "lost"
        if self.scratch != "kept":
            os.mkdir(directory, 0o700)
            os.chown(directory, user.pw_uid, user.pw_gid)
        write_file(self.state_path, json.dumps({"seq": header["seq"], "gen": header["gen"]}))
        return directory

    def extract(self, archive, members):
        make_root_dir(self.skills, 0o755)
        # A dead runner's staging directories and links, none of them installed, are removed; none is ever reused.
        installed = set()
        for entry in os.listdir(self.skills):
            path = os.path.join(self.skills, entry)
            if not entry.startswith(".") and os.path.islink(path):
                installed.add(os.readlink(path))
        for entry in os.listdir(self.skills):
            if (entry.startswith(".stage-") and entry not in installed) or entry.startswith(".link-"):
                remove(os.path.join(self.skills, entry))
        # Named apart from the nonce, which must stay unreadable to the script's user.
        unique = os.urandom(16).hex()
        stage = f".stage-{unique}"
        staging = os.path.join(self.skills, stage)
        os.mkdir(staging, 0o755)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
            tar.extractall(staging, members=members, filter="data")
        previous = os.readlink(self.skill_dir) if os.path.islink(self.skill_dir) else None
        if previous is None and os.path.lexists(self.skill_dir):
            remove(self.skill_dir)
        link = os.path.join(self.skills, f".link-{unique}")
        os.symlink(stage, link)
        os.replace(link, self.skill_dir)
        if previous is not None and previous != stage and previous.startswith(".stage-"):
            remove(os.path.join(self.skills, previous))

    def spawn(self, script, scratch, stdin):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            raise Ended("failed:subreaper")
        write_file(self.marker, f"{os.getpid()} {self.nonce}\n")
        environment = {
            "HOME": scratch,
            "CLAUDE_SKILL_DIR": self.skill_dir,
            "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
            "LANG": "C.UTF-8",
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        limit = float(os.environ.get("PRQ_SCRIPT_S", "120"))
        # From the marker on, the cleanup counts as done only once it is recorded.
        self.clean = 0
        end = "failed:spawn"
        try:
            process = subprocess.Popen(
                ["python3", script, *self.argv[2:]],
                user=self.user,
                group=self.user,
                extra_groups=[],
                start_new_session=True,
                cwd=scratch,
                env=environment,
                stdin=subprocess.PIPE,
                close_fds=True,
            )
            try:
                process.communicate(stdin, timeout=limit)
                code = process.returncode
                end = f"exit:{code if code >= 0 else 128 - code}"
            except subprocess.TimeoutExpired:
                end = "timeout"
                try:
                    process.stdin.close()
                except OSError:
                    pass
        finally:
            # Whatever ended the script, its processes are reaped, and the marker goes only once they all are.
            if reap(time.monotonic() + REAP_S):
                os.unlink(self.marker)
                self.clean = 1
        return end


def children():
    """The runner's own unreaped direct children: the kernel keeps each PID reserved until the runner reaps it."""
    try:
        with open(f"/proc/self/task/{os.getpid()}/children", encoding="ascii") as file:
            return [int(pid) for pid in file.read().split()]
    except FileNotFoundError:
        return []


def reap(deadline):
    """Kills and reaps every child, and every orphan adopted meanwhile, until waitpid reports none (ECHILD)."""
    while True:
        try:
            while True:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
        except ChildProcessError:
            return True
        for pid in children():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)


def prepare_process(pid):
    """Whether the process is root's and named as a prepare's processes are."""
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8", errors="replace") as file:
            status = file.read()
    except OSError:
        return False
    name = re.search(r"^Name:\t(.*)$", status, re.MULTILINE)
    uid = re.search(r"^Uid:\t(\d+)", status, re.MULTILINE)
    return name is not None and uid is not None and uid.group(1) == "0" and PREPARE_NAMES.fullmatch(name.group(1))


def reset_cleanup():
    me = os.getpid()
    killed = 0
    try:
        pids = [int(entry) for entry in os.listdir("/proc") if entry.isdigit()]
    except OSError:
        return 2
    for pid in pids:
        if pid == me or not prepare_process(pid):
            continue
        try:
            descriptor = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        except OSError:
            # No pidfd (a kernel or an emulator without pidfd_open): the process cannot be signalled safely, so the
            # cleanup could not look, and the Workspace stops the container instead.
            return 2
        try:
            # Checked again once the pidfd holds the process: a PID recycled before the open names another process,
            # which this check refuses, and one recycled after it is not the pidfd's.
            if prepare_process(pid):
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                killed += 1
        except ProcessLookupError:
            pass
        except OSError:
            return 2
        finally:
            os.close(descriptor)
    return 0 if killed > 0 else 1


def main(argv):
    if argv == ["--reset-cleanup"]:
        return reset_cleanup()
    started = time.monotonic()
    os.umask(0o022)
    if len(argv) < 7 or argv[0] != "--root" or argv[2] != "--user" or argv[5] != "--":
        print("usage: prq-skill-run --root ROOT --user USER NAME -- ARGV...", file=sys.stderr)
        return 2
    root, user, name, script = argv[1], argv[3], argv[4], argv[6:]
    runner = Runner(root, user, name, script)
    if not SKILL_NAME.fullmatch(name) or len(name) > 64:
        runner.trailer("failed:name")
        return 0
    try:
        end = runner.run(started)
    except Ended as ended:
        end = ended.end
    except Exception as error:  # every ending writes a trailer
        print(f"prq-skill-run: {type(error).__name__}: {error}"[:500], file=sys.stderr)
        end = "failed:error"
    runner.trailer(end)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
