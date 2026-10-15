import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readJsonBody } from "../../src/api/read-json-body";

const post = (body: BodyInit) => new Request("http://x.test/", { method: "POST", body });

async function assertBadRequest(result: unknown, error: string): Promise<void> {
  assert.ok(result instanceof Response);
  assert.equal(result.status, 400);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await result.json(), { error });
}

describe("readJsonBody", () => {
  it("returns the parsed body", async () => {
    assert.deepEqual(await readJsonBody(post('{"a":1}'), 100), { a: 1 });
  });

  it("answers too_large above the cap, or the given code", async () => {
    await assertBadRequest(await readJsonBody(post('{"a":1}'), 3), "too_large");
    await assertBadRequest(await readJsonBody(post('{"a":1}'), 3, "invalid_request"), "invalid_request");
  });

  it("answers invalid_json for malformed JSON", async () => {
    await assertBadRequest(await readJsonBody(post("{nope"), 100), "invalid_json");
  });

  it("answers invalid_request when the body cannot be read", async () => {
    const request = post("{}");
    await request.text();
    await assertBadRequest(await readJsonBody(request, 100), "invalid_request");
  });
});
