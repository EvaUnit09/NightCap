import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const monitorSchema = z.object({
  name: z.string().min(1),
  type: z.literal("query alert"),
  query: z.string().min(1),
  message: z.string().min(1).refine((value) => !value.includes("@"), "monitor message must not include a notification handle"),
  tags: z.array(z.string()),
  options: z.object({
    thresholds: z.object({
      critical: z.number(),
    }),
    notify_no_data: z.boolean(),
    require_full_window: z.boolean(),
    timeout_h: z.number().int().positive().optional(),
  }),
});

const listedSchema = z.array(z.object({ id: z.number().int().positive(), name: z.string() }));

const writtenSchema = z.object({
  id: z.number().int().positive(),
});

export type MonitorDefinition = z.infer<typeof monitorSchema>;

export type MonitorWrite = {
  readonly name: string;
  readonly action: "created" | "updated";
  readonly id: number;
};

export interface MonitorClient {
  readonly apiKey: string;
  readonly appKey: string;
  readonly site: string | undefined;
  readonly fetch: typeof fetch;
}

const ENV_TOKEN = /^[A-Za-z0-9._-]{1,32}$/;
const HANDLE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;

export function datadogApiOrigin(site: string | undefined): string {
  const host = site === undefined || site.trim() === "" ? "datadoghq.com" : site.trim();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new Error("DD_SITE must be a hostname");
  }
  return `https://api.${host}`;
}

export function loadMonitors(dir: URL = new URL("./monitors/", import.meta.url)): readonly MonitorDefinition[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return names.map((name) => monitorSchema.parse(JSON.parse(readFileSync(new URL(name, dir), "utf8"))));
}

export function prepareMonitors(
  monitors: readonly MonitorDefinition[],
  options: { readonly envName?: string; readonly notify?: string } = {},
): MonitorDefinition[] {
  return monitors.map((monitor) => withNotify(rewriteEnv(monitor, options.envName ?? "prod"), options.notify));
}

export function dryRunText(monitors: readonly MonitorDefinition[], site: string | undefined): string {
  const origin = datadogApiOrigin(site);
  return monitors.map((monitor) => `POST ${origin}/api/v1/monitor\n${JSON.stringify(monitor, null, 2)}`).join("\n");
}

export async function validateMonitors(monitors: readonly MonitorDefinition[], client: MonitorClient): Promise<void> {
  const origin = datadogApiOrigin(client.site);
  for (const monitor of monitors) {
    const response = await client.fetch(`${origin}/api/v1/monitor/validate`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { ...authHeaders(client), "content-type": "application/json" },
      body: JSON.stringify(monitor),
    });
    if (!response.ok) throw new Error(`Datadog monitor HTTP ${response.status}`);
    await response.arrayBuffer();
  }
}

export async function applyMonitors(
  monitors: readonly MonitorDefinition[],
  client: MonitorClient,
): Promise<readonly MonitorWrite[]> {
  const origin = datadogApiOrigin(client.site);
  const existing = await listManaged(origin, client);
  const writes: MonitorWrite[] = [];
  for (const monitor of monitors) {
    const hits = existing.filter((hit) => hit.name === monitor.name);
    if (hits.length === 0) {
      const id = await writeMonitor("POST", `${origin}/api/v1/monitor`, monitor, client);
      writes.push({ name: monitor.name, action: "created", id });
      continue;
    }
    for (const hit of hits) {
      const id = await writeMonitor("PUT", `${origin}/api/v1/monitor/${hit.id}`, monitor, client);
      writes.push({ name: monitor.name, action: "updated", id });
    }
  }
  return writes;
}

function rewriteEnv(monitor: MonitorDefinition, envName: string): MonitorDefinition {
  if (envName === "prod") return monitor;
  if (!ENV_TOKEN.test(envName)) throw new Error("monitor env must be a single token");
  const next = `env:${envName}`;
  return {
    ...monitor,
    name: `${monitor.name} [${envName}]`,
    query: monitor.query.replaceAll("env:prod", next),
    tags: monitor.tags.map((tag) => (tag === "env:prod" ? next : tag)),
  };
}

function withNotify(monitor: MonitorDefinition, handle: string | undefined): MonitorDefinition {
  if (handle === undefined || handle.length === 0) return monitor;
  const token = handle.startsWith("@") ? handle.slice(1) : handle;
  if (!HANDLE_TOKEN.test(token)) throw new Error("notify handle must be a single token");
  return { ...monitor, message: `${monitor.message} @${token}` };
}

async function listManaged(origin: string, client: MonitorClient): Promise<readonly { id: number; name: string }[]> {
  const url = new URL(`${origin}/api/v1/monitor`);
  url.searchParams.set("monitor_tags", "managed-by:ops-datadog");
  const response = await client.fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: authHeaders(client),
  });
  return listedSchema.parse(await readBody(response));
}

async function writeMonitor(
  method: "POST" | "PUT",
  url: string,
  monitor: MonitorDefinition,
  client: MonitorClient,
): Promise<number> {
  const response = await client.fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { ...authHeaders(client), "content-type": "application/json" },
    body: JSON.stringify(monitor),
  });
  return writtenSchema.parse(await readBody(response)).id;
}

function authHeaders(client: MonitorClient): Record<string, string> {
  return {
    "DD-API-KEY": client.apiKey,
    "DD-APPLICATION-KEY": client.appKey,
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`Datadog monitor HTTP ${response.status}`);
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function redact(text: string): string {
  let out = text;
  for (const secret of [process.env.DD_API_KEY, process.env.DD_APP_KEY]) {
    const trimmed = secret?.trim();
    if (trimmed !== undefined && trimmed.length > 0) out = out.split(trimmed).join("[redacted]");
  }
  return out;
}

function readArgs(argv: readonly string[]): { validate: boolean; apply: boolean; envName: string; notify: string | undefined } {
  let validate = false;
  let apply = false;
  let envName = "prod";
  let notify: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--validate") {
      validate = true;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--env" || arg === "--notify") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--env") envName = value;
      else notify = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return { validate, apply, envName, notify };
}

function requireKeys(): { apiKey: string; appKey: string } {
  const apiKey = process.env.DD_API_KEY?.trim();
  const appKey = process.env.DD_APP_KEY?.trim();
  if (!apiKey || !appKey) {
    throw new Error("--validate and --apply need DD_API_KEY and DD_APP_KEY");
  }
  return { apiKey, appKey };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<number> {
  const args = readArgs(process.argv.slice(2));
  const monitors = prepareMonitors(loadMonitors(), { envName: args.envName, notify: args.notify });
  if (!args.validate && !args.apply) {
    process.stdout.write(`${redact(dryRunText(monitors, process.env.DD_SITE))}\n`);
    return 0;
  }
  const keys = requireKeys();
  const client: MonitorClient = { ...keys, site: process.env.DD_SITE, fetch };
  if (args.validate) await validateMonitors(monitors, client);
  if (args.apply) {
    const writes = await applyMonitors(monitors, client);
    for (const write of writes) {
      process.stdout.write(`${write.action} ${write.name} id=${write.id}\n`);
    }
  }
  return 0;
}

if (isDirectRun()) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "monitor create failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
