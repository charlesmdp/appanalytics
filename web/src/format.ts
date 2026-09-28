import type { MetricFormat } from './api';

/**
 * Compact money for tiles and axes, full precision in tooltips and tables.
 * Currency comes from the data, never a hard-coded locale assumption.
 */
export function formatValue(
  value: number,
  format: MetricFormat,
  currency: string | null,
  options: { compact?: boolean } = {},
): string {
  if (!Number.isFinite(value)) return '—';

  switch (format) {
    case 'money': {
      // `narrowSymbol` keeps USD as "$" rather than the locale-qualified "US$".
      const settings: Intl.NumberFormatOptions = currency
        ? { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }
        : { style: 'decimal' };
      // Axis ticks compact uniformly, so a scale never mixes "$16K" with
      // "$8,000.00". Everything a reader actually reads carries its cents.
      if (options.compact) {
        return new Intl.NumberFormat(undefined, {
          ...settings,
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(value);
      }
      return new Intl.NumberFormat(undefined, {
        ...settings,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    }
    case 'percent':
      return `${new Intl.NumberFormat(undefined, {
        minimumFractionDigits: options.compact ? 1 : 2,
        maximumFractionDigits: options.compact ? 1 : 2,
      }).format(value)}%`;
    case 'count':
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
    default:
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
}

export function formatBucketDate(iso: string, interval: string): string {
  const date = new Date(iso);
  switch (interval) {
    case 'hour':
      return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
    case 'month':
      return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    default:
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}

export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * A calendar date that was never an instant — the day the App Store says a
 * review was posted, with no time attached because the listing never shows one.
 *
 * Read as UTC rather than in the browser's timezone, which is the opposite of
 * what `formatFullDate` must do. A real instant belongs to whatever day it fell
 * on for the reader; a date has no timezone to be converted out of, so pushing
 * it through one only moves it. A review dated the 29th, stored as the 29th at
 * midnight, renders as the 28th anywhere west of UTC — every reader in the
 * Americas sees each review a day early.
 *
 * Takes `YYYY-MM-DD` as stored, so nothing has to fabricate a time first.
 */
export function formatCalendarDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A stored instant read back in the browser's own timezone. Sync times are the
 * one figure a reader checks against their own clock — "is this stale?" — so
 * they carry the time of day and are never shown in UTC.
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    // Padded, so a 24-hour locale reads "06:41" rather than the bare "6:41"
    // that could be mistaken for an evening time.
    hour: '2-digit',
    minute: '2-digit',
  });
}
