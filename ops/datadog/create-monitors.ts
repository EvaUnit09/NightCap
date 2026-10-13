import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { datadogApiOrigin } from "../../src/monitoring/datadog-metrics";

const monitorSchema = z.object({
  name: z.string().min(1),
  type: z.literal("query alert"),
  query: z.string().min(1),
  message: z.string().min(1),
  tags: z.array(z.string()),
  options: z.object({
    thresholds: z.object({
      critical: z.number(),
    }),
    notify_no_data: z.boolean(),
    require_full_window: z.boolean(),
  }),
});

const monitorFileSchema = z.object({
  monitors: z.array(monitorSchema).length(2),
});

const searchSchema = z.object({
  monitors: z.array(z.object({ id: z.number().int().positive(), name: z.string() })).default([]),
});

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

export const MONITORS_CREATE_DISABLED =
  "[monitoring] Datadog monitor create disabled: DD_MONITORS_APPLY is not 1, so no monitor was created";

export function loadMonitors(text?: string): readonly MonitorDefinition[] {
  const raw = text ?? readFileSync(new URL("./monitors.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  return monitorFileSchema.parse(parsed).monitors;
}

export async function applyMonitors(
  monitors: readonly MonitorDefinition[],
  client: MonitorClient,
): Promise<readonly MonitorWrite[]> {
  const origin = datadogApiOrigin(client.site);
  const writes: MonitorWrite[] = [];
  for (const monitor of monitors) {
    const existing = await searchByName(origin, monitor.name, client);
    if (existing.length === 0) {
      const id = await writeMonitor("POST", `${origin}/api/v1/monitor`, monitor, client);
      writes.push({ name: monitor.name, action: "created", id });
      continue;
    }
    for (const hit of existing) {
      const id = await writeMonitor("PUT", `${origin}/api/v1/monitor/${hit.id}`, monitor, client);
      writes.push({ name: monitor.name, action: "updated", id });
    }
  }
  return writes;
}

export async function writeDryRunReceipt(dir: string, name: string, body: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

async function searchByName(origin: string, name: string, client: MonitorClient): Promise<readonly { id: number; name: string }[]> {
  const url = new URL(`${origin}/api/v1/monitor/search`);
  url.searchParams.set("query", `title:"${name}"`);
  const response = await client.fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: authHeaders(client),
  });
  const parsed = searchSchema.parse(await readBody(response));
  return parsed.monitors.filter((hit) => hit.name === name);
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
    headers: {
      ...authHeaders(client),
      "content-type": "application/json",
    },
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
  if (!response.ok) {
    throw new Error(`Datadog monitor HTTP ${response.status}`);
  }
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<number> {
  const monitors = loadMonitors();
  if (process.env.DD_MONITORS_APPLY !== "1") {
    console.warn(MONITORS_CREATE_DISABLED);
    const dir = process.env.NIGHTCAP_MONITOR_RECEIPT_DIR ?? "/opt/cursor/artifacts";
    const path = await writeDryRunReceipt(dir, "s7-33-create-noop.json", {
      mode: "dry-run",
      warning: MONITORS_CREATE_DISABLED,
      monitors,
    });
    console.log(`receipt ${path}`);
    return 0;
  }
  const apiKey = process.env.DD_API_KEY?.trim();
  const appKey = process.env.DD_APP_KEY?.trim();
  if (!apiKey || !appKey) {
    console.warn("[monitoring] Datadog monitor create disabled: DD_API_KEY and DD_APP_KEY are both required");
    return 0;
  }
  const writes = await applyMonitors(monitors, {
    apiKey,
    appKey,
    site: process.env.DD_SITE,
    fetch,
  });
  for (const write of writes) {
    console.log(`${write.action} ${write.name} id=${write.id}`);
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
