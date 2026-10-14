export type MonitorStatus = "OK" | "Alert";

export type MonitorComparator = ">=" | ">";

export interface MonitorQuery {
  readonly kind: "spend" | "error_rate";
  readonly windowMs: number;
  readonly metric: string;
  readonly requestMetric: string;
  readonly tags: readonly string[];
  readonly requestTags: readonly string[];
  readonly comparator: MonitorComparator;
  readonly threshold: number;
}

export interface EvalPoint {
  readonly metric: string;
  readonly value: number;
  readonly atMs: number;
  readonly tags: readonly string[];
}

const SPEND_QUERY =
  /^max\((last_\d+[mhd])\):max:(nightcap\.spend\.daily_fraction)\{([^{}]*)\} (>=|>) ([0-9]+(?:\.[0-9]+)?)$/;

const ERROR_QUERY =
  /^sum\((last_\d+[mhd])\):sum:(nightcap\.plan\.errors)\{([^{}]*)\}\.as_count\(\) \/ sum:(nightcap\.plan\.requests)\{([^{}]*)\}\.as_count\(\) (>=|>) ([0-9]+(?:\.[0-9]+)?)$/;

export function parseMonitorQuery(query: string): MonitorQuery {
  const spend = SPEND_QUERY.exec(query);
  if (spend) {
    const tags = splitTags(spend[3]);
    return {
      kind: "spend",
      windowMs: windowMs(spend[1]),
      metric: spend[2],
      requestMetric: spend[2],
      tags,
      requestTags: tags,
      comparator: comparator(spend[4]),
      threshold: Number(spend[5]),
    };
  }
  const error = ERROR_QUERY.exec(query);
  if (error) {
    return {
      kind: "error_rate",
      windowMs: windowMs(error[1]),
      metric: error[2],
      requestMetric: error[4],
      tags: splitTags(error[3]),
      requestTags: splitTags(error[5]),
      comparator: comparator(error[6]),
      threshold: Number(error[7]),
    };
  }
  throw new Error("monitor query is not a spend max or an error-rate ratio");
}

export function evaluateMonitor(
  query: MonitorQuery,
  points: readonly EvalPoint[],
  nowMs: number,
  previous: MonitorStatus,
): { readonly state: MonitorStatus; readonly value: number | null } {
  const inWindow = points.filter((point) => point.atMs >= nowMs - query.windowMs && point.atMs <= nowMs);
  if (query.kind === "spend") {
    const matched = inWindow.filter((point) => point.metric === query.metric && hasTags(point, query.tags));
    if (matched.length === 0) return { state: previous, value: null };
    const value = matched.reduce((max, point) => Math.max(max, point.value), Number.NEGATIVE_INFINITY);
    return { state: breached(value, query.comparator, query.threshold) ? "Alert" : "OK", value };
  }
  if (query.kind === "error_rate") {
    const errors = sumMatched(inWindow, query.metric, query.tags);
    const requests = sumMatched(inWindow, query.requestMetric, query.requestTags);
    if (requests === 0) return { state: previous, value: null };
    const value = errors / requests;
    return { state: breached(value, query.comparator, query.threshold) ? "Alert" : "OK", value };
  }
  const neverKind: never = query.kind;
  return neverKind;
}

function sumMatched(points: readonly EvalPoint[], metric: string, tags: readonly string[]): number {
  return points.reduce((sum, point) => (point.metric === metric && hasTags(point, tags) ? sum + point.value : sum), 0);
}

function hasTags(point: EvalPoint, required: readonly string[]): boolean {
  return required.every((tag) => point.tags.includes(tag));
}

function splitTags(raw: string): readonly string[] {
  if (raw.length === 0) return [];
  return raw.split(",");
}

function comparator(raw: string): MonitorComparator {
  switch (raw) {
    case ">=":
    case ">":
      return raw;
    default:
      throw new Error("monitor comparator must be >= or >");
  }
}

function windowMs(token: string): number {
  const match = /^last_(\d+)([mhd])$/.exec(token);
  if (!match) throw new Error("monitor window must look like last_5m");
  const amount = Number(match[1]);
  const unit = windowUnit(match[2]);
  switch (unit) {
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    case "d":
      return amount * 86_400_000;
    default: {
      const neverUnit: never = unit;
      return neverUnit;
    }
  }
}

function windowUnit(raw: string): "m" | "h" | "d" {
  if (raw === "m" || raw === "h" || raw === "d") return raw;
  throw new Error("monitor window must look like last_5m");
}

function breached(value: number, compare: MonitorComparator, threshold: number): boolean {
  switch (compare) {
    case ">=":
      return value >= threshold;
    case ">":
      return value > threshold;
    default: {
      const neverCompare: never = compare;
      return neverCompare;
    }
  }
}
