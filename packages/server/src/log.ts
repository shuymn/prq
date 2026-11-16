// One log event: an object Workers Logs indexes by field. The event names the operation (`prq.<area>.<operation>`);
// what changed goes in the fields. Never logged: tokens, request bodies, secrets, question or answer text.

// `warn` for a rejected request, `error` for something that should have worked and did not; others pass none.
type LogLevel = "warn" | "error";

export function log(event: `prq.${string}`, fields: Record<string, unknown> = {}, level?: LogLevel): void {
  console[level ?? "log"]({ event, ...fields });
}
