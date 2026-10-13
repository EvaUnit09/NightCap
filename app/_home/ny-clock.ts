import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let snapshot: Date | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  snapshot = new Date();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    snapshot = new Date();
    timer = setInterval(emit, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function clientSnapshot(): Date {
  snapshot ??= new Date();
  return snapshot;
}

export function formatNyTime(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(now);
}

export function useNyClock(): Date | null {
  return useSyncExternalStore(subscribe, clientSnapshot, () => null);
}
