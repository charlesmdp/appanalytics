import type { Window } from './time.js';

/** Display hint only; the API never formats numbers itself. */
export type MetricFormat = 'money' | 'percent' | 'count' | 'number';

/**
 * Stock metrics describe a level at an instant (MRR, active subscriptions) and
 * summarize to their last point. Flow metrics describe activity across a span
 * (earnings, trials started) and summarize to their sum. Getting this backwards
 * is how a dashboard ends up reporting one month's revenue as the year's.
 */
export type MetricKind = 'stock' | 'flow';

export interface TimeSeriesPoint {
  value: number;
  /** Change against the previous bucket; null when there is no baseline. */
  change: number | null;
  periodStart: string;
  periodEnd: string;
  /** The newest bucket is still filling and will move. */
  provisional?: boolean;
}

export interface NamedSeries {
  key: string;
  name: string;
  data: Array<{ date: string; value: number }>;
}

/**
 * The same metric measured over the equal-length span immediately before the
 * requested one. This is a *period* comparison, not a bucket-over-bucket delta:
 * "last 30 days vs the 30 days before" is the question a headline figure raises,
 * and answering it with the last two buckets instead would compare two days.
 */
export interface MetricComparison {
  previousValue: number;
  change: number;
  /** Null when the previous period was zero — no finite percentage exists. */
  changePercent: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface MetricResponse {
  metric: string;
  value: number;
  format: MetricFormat;
  currency: string | null;
  period: string;
  periodStart: string;
  periodEnd: string;
  timeSeriesInterval: string;
  timeSeries: TimeSeriesPoint[];
  /** Component breakdowns, e.g. monthly vs annual vs usage MRR. */
  series?: NamedSeries[];
  /** Absent when there is no history to compare against. */
  comparison?: MetricComparison;
  meta?: Record<string, unknown>;
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export interface BuildResponseInput {
  metric: string;
  kind: MetricKind;
  format: MetricFormat;
  window: Window;
  /** One value per visible bucket, in order. */
  values: number[];
  /**
   * The value for the hidden leading bucket. It exists only so the first
   * visible point has a real period-over-period change, and is never returned.
   */
  leadingValue?: number | null;
  currency?: string | null;
  series?: NamedSeries[];
  meta?: Record<string, unknown>;
  now?: Date;
  /**
   * Replaces the headline figure for metrics that are neither a level nor a
   * total — a ratio over the whole window, say, where the last bucket is
   * systematically incomplete and summing is meaningless.
   */
  summaryOverride?: number;
}

export function buildResponse(input: BuildResponseInput): MetricResponse {
  const { window, values, kind } = input;
  const now = input.now ?? new Date();

  const points: TimeSeriesPoint[] = window.buckets.map((bucket, index) => {
    const value = round(values[index] ?? 0);
    const previous = index === 0 ? input.leadingValue ?? null : values[index - 1] ?? 0;
    return {
      value,
      change: previous === null || previous === undefined ? null : round(value - previous),
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      ...(bucket.end.getTime() >= now.getTime() ? { provisional: true } : {}),
    };
  });

  const summary =
    input.summaryOverride !== undefined
      ? input.summaryOverride
      : kind === 'stock'
        ? points.at(-1)?.value ?? 0
        : values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

  return {
    metric: input.metric,
    value: round(summary),
    format: input.format,
    currency: input.currency ?? null,
    period: window.period,
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    timeSeriesInterval: window.interval,
    timeSeries: points,
    ...(input.series ? { series: input.series } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  };
}
