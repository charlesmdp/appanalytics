/**
 * Growth rates (spec 4.8).
 *
 * A growth metric is a derivative of a level, never a measurement of its own.
 * Deriving it here rather than in each report means MRR growth and subscription
 * growth cannot drift apart from the MRR and subscription series they describe.
 */

export interface Growth {
  /** One percentage per visible bucket, against the bucket before it. */
  values: number[];
  /** Growth across the whole window: end level against the level at its start. */
  periodGrowth: number;
  /** Buckets whose predecessor was zero, so no finite rate exists. */
  undefinedBuckets: number;
}

/**
 * `levels` is a stock series that leads with the hidden bucket at index 0, which
 * is exactly what makes the first *visible* bucket's growth real rather than
 * null: it has the level immediately before the window to divide by.
 *
 * A zero predecessor yields 0, not Infinity. Going from no revenue to some
 * revenue is unbounded growth, and rendering that as a number would put a
 * meaningless spike on the chart; the count is reported in meta instead.
 */
export function growthFrom(levels: number[]): Growth {
  const values: number[] = [];
  let undefinedBuckets = 0;

  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1] ?? 0;
    const current = levels[index] ?? 0;
    if (previous === 0) {
      undefinedBuckets += 1;
      values.push(0);
      continue;
    }
    values.push(((current - previous) / Math.abs(previous)) * 100);
  }

  const first = levels[0] ?? 0;
  const last = levels.at(-1) ?? 0;
  const periodGrowth = first === 0 ? 0 : ((last - first) / Math.abs(first)) * 100;

  return { values, periodGrowth, undefinedBuckets };
}
