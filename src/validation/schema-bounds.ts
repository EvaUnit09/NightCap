import { intentSchema } from "./intent";
import { itineraryOptionSchema, itinerarySchema } from "./itinerary";

export interface LengthBounds {
  min: number;
  max: number;
}

/**
 * Read min/max length checks off a Zod 4 array (or a wrapper whose `def` is an array).
 * Used so the validator follows schema bounds instead of hardcoded 2–4 / 2–3.
 */
export function readArrayLengthBounds(schema: unknown): LengthBounds | null {
  const def = zodDef(schema);
  if (!def || def.type !== "array" || !Array.isArray(def.checks)) {
    return null;
  }
  let min: number | undefined;
  let max: number | undefined;
  for (const check of def.checks) {
    const checkDef = zodDef(check);
    if (!checkDef) continue;
    if (checkDef.check === "min_length" && typeof checkDef.minimum === "number") {
      min = checkDef.minimum;
    }
    if (checkDef.check === "max_length" && typeof checkDef.maximum === "number") {
      max = checkDef.maximum;
    }
  }
  if (min === undefined || max === undefined) {
    return null;
  }
  return { min, max };
}

function zodDef(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const rec = schema as {
    def?: unknown;
    _def?: unknown;
    _zod?: { def?: unknown };
  };
  const def = rec.def ?? rec._def ?? rec._zod?.def;
  return def && typeof def === "object" ? (def as Record<string, unknown>) : null;
}

function objectShape(schema: unknown): Record<string, unknown> | null {
  const def = zodDef(schema);
  const shape = def?.shape;
  if (typeof shape === "function") {
    return (shape as () => Record<string, unknown>)();
  }
  if (shape && typeof shape === "object") {
    return shape as Record<string, unknown>;
  }
  return null;
}

function fieldBounds(schema: unknown, field: string): LengthBounds {
  const shape = objectShape(schema);
  return (
    readArrayLengthBounds(shape?.[field]) ?? {
      min: 0,
      max: Number.POSITIVE_INFINITY,
    }
  );
}

/** Option and stop counts currently declared on the itinerary schemas. */
export function readItineraryBounds(): {
  options: LengthBounds;
  stops: LengthBounds;
} {
  return {
    options: fieldBounds(itinerarySchema, "options"),
    stops: fieldBounds(itineraryOptionSchema, "stops"),
  };
}

/** `stopTypes` length currently declared on `intentSchema`. */
export function readIntentStopTypeBounds(): LengthBounds {
  return fieldBounds(intentSchema, "stopTypes");
}

/**
 * Effective stop-count bounds for this intent.
 * If a future `singleStop: true` field is present, the minimum becomes 1.
 * Maximum always comes from the itinerary option schema.
 */
export function effectiveStopBounds(intent: object): LengthBounds {
  const { stops } = readItineraryBounds();
  const singleStop =
    "singleStop" in intent &&
    (intent as { singleStop?: unknown }).singleStop === true;
  return {
    min: singleStop ? Math.min(1, stops.min) : stops.min,
    max: stops.max,
  };
}
