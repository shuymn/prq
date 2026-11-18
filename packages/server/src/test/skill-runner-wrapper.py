"""Runs the container's skill runner (container/prq-skill-run.py) as the test user, for its Node test.

    python3 -I -S skill-runner-wrapper.py <runner> <runner's arguments>

Only the user switch is faked: pwd.getpwnam("skill") answers the current user, os.chown does nothing, and Popen gets no
user, group or extra groups, since a test user can switch to none. With PRQ_TEST_HOLD_EXTRACT naming a file, the
extraction stops after its first member, creates that file and waits to be killed.
"""

import os
import pwd
import runpy
import subprocess
import sys
import tarfile
import time

current = pwd.getpwuid(os.getuid())
real_getpwnam = pwd.getpwnam
pwd.getpwnam = lambda name: current if name == "skill" else real_getpwnam(name)
os.chown = lambda *args, **kwargs: None
RealPopen = subprocess.Popen


class Popen(RealPopen):
    def __init__(self, *args, user=None, group=None, extra_groups=None, **kwargs):
        super().__init__(*args, **kwargs)


subprocess.Popen = Popen

hold = os.environ.pop("PRQ_TEST_HOLD_EXTRACT", None)
if hold is not None:
    extract_one = tarfile.TarFile._extract_one
    extracted = []

    def held(self, *args, **kwargs):
        extract_one(self, *args, **kwargs)
        extracted.append(True)
        if len(extracted) == 1:
            with open(hold, "w", encoding="utf-8"):
                pass
            while True:
                time.sleep(1)

    tarfile.TarFile._extract_one = held

runner = sys.argv[1]
sys.argv = [runner, *sys.argv[2:]]
runpy.run_path(runner, run_name="__main__")
