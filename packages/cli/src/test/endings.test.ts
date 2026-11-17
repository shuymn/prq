import { describe, expect, it } from "vitest";

import { Endings } from "./endings.ts";

describe("Endings", () => {
  it("runs every ending last first, once, past one that throws, and returns what was thrown", async () => {
    const endings = new Endings();
    const ran: string[] = [];
    const failure = new Error("the stand-in did not close");
    endings.add(async () => {
      ran.push("root");
    });
    endings.add(async () => {
      ran.push("stand-in");
      throw failure;
    });
    endings.add(async () => {
      ran.push("server");
    });

    expect(await endings.run()).toEqual([failure]);
    expect(ran).toEqual(["server", "stand-in", "root"]);
    expect(await endings.run()).toEqual([]);
    expect(ran).toHaveLength(3);
  });
});
