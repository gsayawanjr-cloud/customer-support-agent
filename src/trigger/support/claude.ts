import Anthropic from "@anthropic-ai/sdk";

/** Model for both Claude steps. Opus 5.5 was the user's choice; SUPPORT_MODEL overrides it. */
export function supportModel(): string {
  return process.env.SUPPORT_MODEL?.trim() || "claude-opus-5-5";
}

export function claudeClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
}

/**
 * Server-side fallback: if a safety classifier declines the request, the API retries it on a model
 * picked for that category instead of failing. A refusal that still comes back is escalated.
 */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// USD per million tokens (input, output), from the claude-api skill's model table (2026-10).
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export function estimateCost(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const [input, output] = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  return (usage.input_tokens * input + usage.output_tokens * output) / 1_000_000;
}
