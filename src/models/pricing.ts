import "server-only";

/** USD per one million tokens. */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Anthropic first-party list prices (scope §3).
 * Keyed by model id, so a PLAN_MODEL_ID override to a model listed here
 * prices correctly. A model missing from this table has no cost on its span.
 *
 * Haiku 5.5's short-prompt rate (under 100k input tokens) is the row below.
 * Prompts over 100k tokens are $0.50 / $2.50 per MTok and are not priced here.
 */
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
};

/** List-price cost of one model call, or undefined when the model is not priced here. */
export function costUsdFor(model: string, usage: TokenUsage): number | undefined {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (price === undefined) {
    return undefined;
  }
  return (
    (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) /
    TOKENS_PER_MTOK
  );
}
