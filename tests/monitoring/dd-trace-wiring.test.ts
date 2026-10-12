/**
 * Real dd-trace, no network: Datadog's intake and agent are a local server.
 * Every module that can load `@anthropic-ai/sdk` is imported after
 * `registerDatadogTracing`, the same order instrumentation.ts keeps.
 */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-sentinel-anthropic-0001",
  GOOGLE_PLACES_API_KEY: "AIza-sentinel-places-0002",
  DD_API_KEY: "dd-sentinel-datadog-0003",
  REQUEST_HASH_SECRET: "hash-secret-sentinel-0004",
} as const;

const PII_REQUEST = "Cozy drinks then dinner with Sarah Connor in the West Village, text me at (555) 123-4567";

interface Received {
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const received: Received[] = [];
let server: http.Server;
let origin: string;

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("latin1") });
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

/** Agentless LLM Obs posts to https://llmobs-intake.<site>; send it to the local server instead. */
function redirectHttpsToServer(): void {
  const { port } = server.address() as AddressInfo;
  https.request = ((options: https.RequestOptions, callback?: (res: http.IncomingMessage) => void) =>
    http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", host: undefined, port, agent: undefined }, callback)) as typeof https.request;
}

function anthropicReply(json: unknown, model: string): Response {
  const message = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "```json\n" + JSON.stringify(json) + "\n```" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
  };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type LlmobsSpan = {
  readonly span_id: string;
  readonly parent_id: string;
  readonly name: string;
  readonly meta: Record<string, unknown> & {
    readonly "span.kind": string;
    readonly input?: Record<string, unknown>;
    readonly output?: Record<string, unknown>;
  };
  readonly metrics: Record<string, number>;
};

function llmobsSpans(): LlmobsSpan[] {
  return received
    .filter((request) => request.path.includes("llmobs"))
    .flatMap((request) => {
      const payload = JSON.parse(request.body) as unknown;
      const events = Array.isArray(payload) ? payload : [payload];
      return events.flatMap((event: { spans?: LlmobsSpan[] }) => event.spans ?? []);
    });
}

describe("dd-trace wiring with the Anthropic plugin only", () => {
  const placesRequests: Received[] = [];

  before(async () => {
    await startServer();
    redirectHttpsToServer();
    Object.assign(process.env, SECRETS, {
      DD_TRACE_AGENT_URL: origin,
      DD_TRACE_FLUSH_INTERVAL: "50",
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
      DD_REMOTE_CONFIGURATION_ENABLED: "false",
    });

    const { registerDatadogTracing } = await import("../../src/monitoring/datadog-exporter");
    await registerDatadogTracing();

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { createAnthropicModelClient, runPipeline } = await import("../../src/pipeline");
    const { INTENT, OPTION_A, OPTION_B, fakeModels, harness } = await import("../pipeline/orchestrator-harness");

    const replies = [INTENT, { options: [OPTION_A, OPTION_B] }];
    const client = new Anthropic({
      apiKey: SECRETS.ANTHROPIC_API_KEY,
      maxRetries: 0,
      fetch: async (_url, init) => {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        return anthropicReply(replies.shift(), model);
      },
    });
    const h = harness({ models: fakeModels({}) });
    await runPipeline(
      { text: PII_REQUEST, testCaseId: "nc-001" },
      {
        ...h.deps,
        exporter: undefined,
        models: createAnthropicModelClient({ client }),
        retrieve: async (intent, signal) => {
          await fetch(`${origin}/places/v1/places:searchText`, {
            method: "POST",
            headers: { "X-Goog-Api-Key": SECRETS.GOOGLE_PLACES_API_KEY },
            body: "{}",
          });
          await new Promise<void>((resolve) => {
            http.get(`${origin}/routes/distanceMatrix`, { headers: { "X-Goog-Api-Key": SECRETS.GOOGLE_PLACES_API_KEY } }, (res) => {
              res.resume();
              res.on("end", resolve);
            });
          });
          return h.deps.retrieve(intent, signal);
        },
      },
    );

    const { default: tracer } = await import("dd-trace");
    tracer.llmobs.flush();
    await waitFor(() => llmobsSpans().length >= 5, "LLM Obs spans");
    await waitFor(() => received.some((request) => request.path.includes("/traces")), "APM traces");
    placesRequests.push(...received.filter((request) => request.path.startsWith("/places") || request.path.startsWith("/routes")));
  });

  after(() => {
    server.close();
  });

  it("each model call is an llm span with its prompt, reply, and tokens, nested under its stage", () => {
    const spans = llmobsSpans();
    const byId = new Map(spans.map((span) => [span.span_id, span]));
    const llm = spans.filter((span) => span.meta["span.kind"] === "llm");

    assert.equal(llm.length, 2);
    for (const [span, stage, promptName, reply] of [
      [llm[0], "parse", "parse_intent", "West Village"],
      [llm[1], "plan", "plan_itineraries", "Little Branch"],
    ] as const) {
      assert.equal(byId.get(span.parent_id)?.name, stage);
      assert.equal(byId.get(span.parent_id)?.meta["span.kind"], "task");
      const input = JSON.stringify(span.meta.input);
      assert.ok(input.includes('"role":"system"'), `${stage} input has the system prompt`);
      assert.ok(JSON.stringify(span.meta.output).includes(reply), `${stage} output has the reply`);
      assert.equal(span.metrics.input_tokens, 1000);
      assert.equal(span.metrics.output_tokens, 200);
      const prompt = span.meta.input?.prompt as { id?: string; version?: string } | undefined;
      assert.equal(prompt?.id, promptName);
      assert.equal(prompt?.version, "v1");
    }
  });

  it("the workflow span's input is the redacted request and its output the emitted venues", () => {
    const [workflow] = llmobsSpans().filter((span) => span.meta["span.kind"] === "workflow");
    const input = String(workflow.meta.input?.value);
    const output = String(workflow.meta.output?.value);

    assert.ok(input.includes("West Village"));
    assert.ok(!input.includes("Sarah") && !input.includes("555"), "input is redacted");
    assert.ok(output.includes("ChIJbar0") && output.includes("Little Branch"));
  });

  it("only the Anthropic integration runs: Places and Routes requests carry no trace headers and make no spans", () => {
    assert.equal(placesRequests.length, 2);
    for (const request of placesRequests) {
      const injected = Object.keys(request.headers).filter((name) => name.startsWith("x-datadog") || name === "traceparent");
      assert.deepEqual(injected, [], `${request.path} was instrumented`);
    }
    const exported = received.filter((request) => !placesRequests.includes(request)).map((request) => request.body);
    for (const body of exported) {
      assert.ok(!body.includes("searchText") && !body.includes("distanceMatrix"), "a Places or Routes request was traced");
    }
  });

  it("no API key value or the request hash secret appears in anything dd-trace sent", () => {
    const bodies = received.filter((request) => !request.path.startsWith("/places") && !request.path.startsWith("/routes"));
    assert.ok(bodies.length >= 2);
    for (const { path, body } of bodies) {
      for (const [name, value] of Object.entries(SECRETS)) {
        assert.ok(!body.includes(value), `${path} carried ${name}`);
      }
    }
  });
});
