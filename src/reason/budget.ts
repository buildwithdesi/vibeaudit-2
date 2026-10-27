import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Reasoning costs money per token, so the pipeline spends it on purpose.
 * Three caps, all configurable: input tokens per file, output tokens per
 * finding, and dollars per run. When a file hits its cap the remaining
 * findings in that file are marked "budget-exhausted" and still ship in the
 * report with their deterministic v1 result. Nothing is silently dropped.
 */
const RateSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
export type Rate = z.infer<typeof RateSchema>;

const RatesFile = z.object({
  asOf: z.string(),
  unit: z.string(),
  sources: z.array(z.string()),
  models: z.record(z.string(), RateSchema),
});

let cachedRates: z.infer<typeof RatesFile> | null = null;

export function loadRates(): z.infer<typeof RatesFile> {
  if (!cachedRates) {
    const raw = readFileSync(new URL('./rates.json', import.meta.url), 'utf8');
    cachedRates = RatesFile.parse(JSON.parse(raw));
  }
  return cachedRates;
}

export function rateFor(model: string): Rate {
  const rate = loadRates().models[model];
  if (!rate)
    throw new Error(`No rate on file for model "${model}". Add it to src/reason/rates.json.`);
  return rate;
}

export interface Usage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export function costUsd(usage: Usage, rate: Rate): number {
  const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (uncached * rate.input +
      usage.cachedTokens * rate.cachedInput +
      usage.completionTokens * rate.output) /
    1_000_000
  );
}

/** Rough token count. Four characters per token is close enough to plan a budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BudgetConfig {
  perFileInputTokens: number;
  perFindingOutputTokens: number;
  perRunUsd: number;
  maxFindingsPerFile: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  perFileInputTokens: 24_000,
  perFindingOutputTokens: 2_000,
  perRunUsd: 5,
  maxFindingsPerFile: 8,
};

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason: 'file-input-cap' | 'file-finding-cap' | 'run-usd-cap' };

export class ReasoningBudget {
  readonly config: BudgetConfig;
  private readonly fileInput = new Map<string, number>();
  private readonly fileFindings = new Map<string, number>();
  private spent = 0;
  private calls = 0;

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
  }

  get spentUsd(): number {
    return this.spent;
  }

  get callCount(): number {
    return this.calls;
  }

  /** Decide before the call, using the estimated prompt size. */
  canSpend(file: string, estimatedInputTokens: number, rate: Rate): BudgetDecision {
    const used = this.fileInput.get(file) ?? 0;
    if (used + estimatedInputTokens > this.config.perFileInputTokens) {
      return { ok: false, reason: 'file-input-cap' };
    }
    if ((this.fileFindings.get(file) ?? 0) >= this.config.maxFindingsPerFile) {
      return { ok: false, reason: 'file-finding-cap' };
    }
    const worstCase =
      (estimatedInputTokens * rate.input + this.config.perFindingOutputTokens * rate.output) /
      1_000_000;
    if (this.spent + worstCase > this.config.perRunUsd) return { ok: false, reason: 'run-usd-cap' };
    return { ok: true };
  }

  /** Charge the caps with an estimate and no call, so a dry run hits the same limits a live run would. */
  reserve(file: string, estimatedInputTokens: number, outputTokens: number, rate: Rate): number {
    const cost = (estimatedInputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
    this.spent += cost;
    this.fileInput.set(file, (this.fileInput.get(file) ?? 0) + estimatedInputTokens);
    this.fileFindings.set(file, (this.fileFindings.get(file) ?? 0) + 1);
    return cost;
  }

  /** Record what the API actually billed. */
  record(file: string, usage: Usage, rate: Rate): number {
    const cost = costUsd(usage, rate);
    this.spent += cost;
    this.calls += 1;
    this.fileInput.set(file, (this.fileInput.get(file) ?? 0) + usage.promptTokens);
    this.fileFindings.set(file, (this.fileFindings.get(file) ?? 0) + 1);
    return cost;
  }

  summary(): { calls: number; spentUsd: number; files: number } {
    return {
      calls: this.calls,
      spentUsd: Number(this.spent.toFixed(4)),
      files: this.fileInput.size,
    };
  }
}
