// Loads the Worker and its Durable Object classes while a test file is collected. Otherwise the first test that reaches
// a Durable Object transforms and loads the Agents SDK within its own time limit (seconds on a run without Vitest's
// module cache).
await import("../index.ts");
