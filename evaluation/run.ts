/**
 * `npm run eval` entry. The script loads tests/setup.mjs so `server-only`
 * resolves outside Next (see AGENTS.md).
 */
import { runEvalCli } from "./cli";

void runEvalCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  now: () => new Date(),
}).then((code) => {
  process.exitCode = code;
});
