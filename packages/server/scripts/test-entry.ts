// The tests' entry to an operations script: `node scripts/test-entry.ts <fixture.json> deploy|secrets [arguments]`. It
// sets the fixture (fixture.ts) from the file, then runs the script with the arguments as its package script would. The
// script's modules load after the fixture is set, so their settings are the fixture's.

import { readFileSync } from "node:fs";

import * as v from "valibot";

import { Fixture, fixture } from "./fixture.ts";

const [file = "", script = "", ...args] = process.argv.slice(2);
if (script !== "deploy" && script !== "secrets") {
  throw new Error("usage: test-entry.ts <fixture.json> deploy|secrets [arguments]");
}
Object.assign(fixture, v.parse(Fixture, JSON.parse(readFileSync(file, "utf8"))));
process.argv.splice(2, Infinity, ...args);
await import(script === "deploy" ? "./deploy.ts" : "./secrets.ts");
