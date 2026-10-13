/**
 * `npm run eval` entry. The script loads tests/setup.mjs so `server-only`
 * resolves outside Next (see AGENTS.md). Datadog starts before the CLI is
 * imported: dd-trace patches `@anthropic-ai/sdk` only as it first loads.
 */
import { registerDatadogTracing } from "../src/monitoring/datadog-exporter";
import { applyEvalObservabilityDefaults } from "./datadog-experiments";

async function main(): Promise<number> {
  applyEvalObservabilityDefaults(process.env);
  await registerDatadogTracing();
  const { runEvalCli } = await import("./cli");
  return runEvalCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    now: () => new Date(),
  });
}

/** A config error (or any other) is one line on stderr, not a stack, so `--help` still reads cleanly. */
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
