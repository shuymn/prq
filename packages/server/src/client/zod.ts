// The AI SDK's chunk schemas are zod's, and zod probes once for eval with `new Function`, which the page's Trusted Types
// policy blocks and reports as a violation. The jitless setting skips the probe; main.tsx imports this first, so it is
// set before any schema parses.
import { config } from "zod/v4/core";

config({ jitless: true });
