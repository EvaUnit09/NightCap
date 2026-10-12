import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

/** `npm run eval` as a real process, since the bug is what the process prints and how it exits. */
function runEntry(args: readonly string[], env: Record<string, string>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.DD_API_KEY;
  return spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/setup.mjs", "evaluation/run.ts", ...args], {
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("evaluation/run.ts", () => {
  it("prints a config error's message without a stack and exits nonzero", () => {
    const result = runEntry(["--help"], { DATADOG_API_KEY: "x" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATADOG_API_KEY is set but DD_API_KEY is not/);
    assert.doesNotMatch(result.stderr, /^\s+at /m, "no stack trace");
    assert.equal(result.stdout, "");
  });
});
