import { expect, it } from "vitest";

// The suites in this package run inside workerd through @cloudflare/vitest-plugin, not in Node.
it("runs in workerd", () => {
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
});
