import { APPS, DAY, type Env, type App, database, day } from "./config.js";
import { rows, getJob } from "./store.js";
export const PERIODS = [
  { id: "last_30_days", label: "30 derniers jours" },
  { id: "last_month", label: "Mois dernier" },
  { id: "current_month", label: "Mois en cours" },
  { id: "last_90_days", label: "90 derniers jours" },
  { id: "last_365_days", label: "365 derniers jours" },
  { id: "year_to_date", label: "Cette année" },
  { id: "all_time", label: "Tout l’historique" },
];
export interface Daily {
  date: string;
  currency: string;
  mrr_delta: number;
  paying_delta: number;
  installs: number;
  uninstalls: number;
  reactivations: number;
  deactivations: number;
  gross: number;
  net: number;
}
export interface Point {
  date: string;
  mrr: number;
  paying: number;
  installs: number;
  uninstalls: number;
  reactivations: number;
  deactivations: number;
  gross: number;
  net: number;
}
export function range(
  period: string,
  earliest: string,
  now = new Date(),
  customStart?: string,
  customEnd?: string,
) {
  const today = day(now);
  const endOfToday = new Date(`${today}T00:00:00Z`);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let start: Date;
  let end: Date;
  if (period === "custom") {
    if (
      !customStart ||
      !customEnd ||
      !/^\d{4}-\d{2}-\d{2}$/.test(customStart) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(customEnd)
    )
      throw new Error("Choisis deux dates valides.");
    start = new Date(customStart);
    end = new Date(Math.min(Date.parse(customEnd), +endOfToday));
  } else if (period === "last_month") {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    end = new Date(+month - DAY);
  } else if (period === "current_month") {
    start = month;
    end = endOfToday;
  } else if (period === "year_to_date") {
    start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    end = endOfToday;
  } else if (period === "all_time") {
    start = new Date(earliest);
    end = endOfToday;
  } else {
    const count = (
      { last_30_days: 30, last_90_days: 90, last_365_days: 365 } as Record<
        string,
        number
      >
    )[period];
    if (!count) throw new Error("Période inconnue.");
    end = new Date(+endOfToday - DAY);
    start = new Date(+endOfToday - count * DAY);
  }
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    start > end ||
    (+end - +start) / DAY > 7305
  )
    throw new Error("Période invalide (20 ans maximum).");
  return {
    start: day(start),
    end: day(end),
    todayPartial: day(end) === today,
    days: Math.round((+end - +start) / DAY) + 1,
  };
}
export function series(
  data: Daily[],
  start: string,
  end: string,
  currency: string,
) {
  let mrr = 0,
    paying = 0;
  const byDay = new Map<string, Daily[]>();
  for (const row of data) {
    if (row.date < start && row.currency === currency) {
      mrr += row.mrr_delta;
      paying += row.paying_delta;
    }
    const group = byDay.get(row.date) ?? [];
    group.push(row);
    byDay.set(row.date, group);
  }
  const baseline = { mrr, paying };
  const points: Point[] = [];
  for (let at = Date.parse(start); at <= Date.parse(end); at += DAY) {
    const date = day(new Date(at));
    const point: Point = {
      date,
      mrr: 0,
      paying: 0,
      installs: 0,
      uninstalls: 0,
      reactivations: 0,
      deactivations: 0,
      gross: 0,
      net: 0,
    };
    for (const r of byDay.get(date) ?? []) {
      if (r.currency === currency) {
        mrr += r.mrr_delta;
        paying += r.paying_delta;
        point.gross += r.gross;
        point.net += r.net;
      }
      if (r.currency === "") {
        point.installs += r.installs;
        point.uninstalls += r.uninstalls;
        point.reactivations += r.reactivations;
        point.deactivations += r.deactivations;
      }
    }
    point.mrr = Math.abs(mrr) < 1e-7 ? 0 : mrr;
    point.paying = paying;
    points.push(point);
  }
  return { baseline, points };
}
export function summary(
  points: Point[],
  baseline: { mrr: number; paying: number },
) {
  const last = points.at(-1);
  const mrr = last?.mrr ?? 0;
  return {
    mrr,
    paying: last?.paying ?? 0,
    mrrChange: mrr - baseline.mrr,
    mrrGrowth: baseline.mrr > 0 ? (mrr / baseline.mrr - 1) * 100 : null,
    installs: points.reduce((s, p) => s + p.installs, 0),
    uninstalls: points.reduce((s, p) => s + p.uninstalls, 0),
    gross: points.reduce((s, p) => s + p.gross, 0),
    net: points.reduce((s, p) => s + p.net, 0),
    reactivations: points.reduce((s, p) => s + p.reactivations, 0),
    deactivations: points.reduce((s, p) => s + p.deactivations, 0),
  };
}
export async function analytics(
  env: Env,
  params: URLSearchParams,
  now = new Date(),
) {
  const key = params.get("app") ?? "all";
  const apps = key === "all" ? [...APPS] : APPS.filter((a) => a.key === key);
  if (!apps.length) throw new Error("App inconnue.");
  const raw = await Promise.all(
    apps.map(async (app) => ({
      app,
      job: await getJob(database(env, app)),
      data: await rows<Daily>(
        database(env, app),
        "SELECT * FROM daily ORDER BY date,currency",
      ),
    })),
  );
  const currencies = [
    ...new Set(
      raw.flatMap((r) => r.data.map((d) => d.currency).filter(Boolean)),
    ),
  ].sort();
  const currency =
    params.get("currency") ||
    (currencies.includes("USD") ? "USD" : (currencies[0] ?? "USD"));
  if (currencies.length && !currencies.includes(currency))
    throw new Error("Devise inconnue.");
  const selected = range(
    params.get("period") ?? "last_30_days",
    apps.map((a) => a.since).sort()[0]!,
    now,
    params.get("start") ?? undefined,
    params.get("end") ?? undefined,
  );
  const perApp = raw.map(({ app, data, job }) => {
    const s = series(data, selected.start, selected.end, currency);
    return {
      key: app.key,
      name: app.name,
      color: app.color,
      ...s,
      summary: summary(s.points, s.baseline),
      asOf: job.last_success,
      complete:
        Boolean(job.last_success) &&
        job.status !== "running" &&
        job.status !== "error",
    };
  });
  const points = perApp[0]!.points.map((p, i) =>
    perApp.reduce(
      (sum, a) => {
        for (const key of [
          "mrr",
          "paying",
          "installs",
          "uninstalls",
          "reactivations",
          "deactivations",
          "gross",
          "net",
        ] as const)
          sum[key] += a.points[i]![key];
        return sum;
      },
      {
        date: p.date,
        mrr: 0,
        paying: 0,
        installs: 0,
        uninstalls: 0,
        reactivations: 0,
        deactivations: 0,
        gross: 0,
        net: 0,
      } as Point,
    ),
  );
  const baseline = perApp.reduce(
    (s, a) => ({
      mrr: s.mrr + a.baseline.mrr,
      paying: s.paying + a.baseline.paying,
    }),
    { mrr: 0, paying: 0 },
  );
  // Comparison is the preceding equal number of days. Growth of MRR is the change in stock over the selected window.
  const previousEnd = day(new Date(Date.parse(selected.start) - DAY));
  const previousStart = day(
    new Date(Date.parse(selected.start) - selected.days * DAY),
  );
  const prev = raw.map(({ data }) => {
    const s = series(data, previousStart, previousEnd, currency);
    return summary(s.points, s.baseline);
  });
  const previous = prev.reduce(
    (s, p) => ({
      installs: s.installs + p.installs,
      uninstalls: s.uninstalls + p.uninstalls,
      gross: s.gross + p.gross,
    }),
    { installs: 0, uninstalls: 0, gross: 0 },
  );
  const total = summary(points, baseline);
  const allComplete = perApp.every((a) => a.complete);
  const forecastAsOf =
    raw
      .map((r) => r.job.last_success)
      .filter((v): v is string => Boolean(v))
      .sort()[0] ?? null;
  const forecastDay = forecastAsOf ? day(forecastAsOf) : day(now);
  const forecast = {
    asOf: forecastAsOf,
    mrr: raw.reduce(
      (sum, r) =>
        sum + series(r.data, forecastDay, forecastDay, currency).points[0]!.mrr,
      0,
    ),
  };
  const insights: string[] = [];
  if (!allComplete)
    insights.push(
      "Calcul en cours ou synchronisation interrompue : ces résultats sont provisoires. Les projections et l’analyse IA attendent une synchronisation complète.",
    );
  else {
    insights.push(
      total.mrrGrowth === null
        ? "La période commence sans MRR : un pourcentage de croissance ne serait pas significatif."
        : `Le MRR a ${total.mrrChange >= 0 ? "augmenté" : "diminué"} de ${Math.abs(total.mrrGrowth).toFixed(1)} % sur la période.`,
    );
    insights.push(
      `${total.installs} installations et ${total.uninstalls} désinstallations, soit un solde de ${total.installs - total.uninstalls >= 0 ? "+" : ""}${total.installs - total.uninstalls}. Les réactivations et fermetures de boutiques sont comptées séparément.`,
    );
    if (previous.installs > 0)
      insights.push(
        `Les installations évoluent de ${((total.installs / previous.installs - 1) * 100).toFixed(1)} % par rapport aux ${selected.days} jours précédents${selected.todayPartial ? " ; la dernière journée est incomplète" : ""}.`,
      );
  }
  return {
    apps: perApp,
    range: selected,
    currency,
    currencies,
    points,
    baseline,
    summary: total,
    previous,
    forecast,
    complete: allComplete,
    insights,
    timezone: "UTC",
    generatedAt: now.toISOString(),
  };
}
export interface ScenarioInput {
  monthlyGrowth: number;
  months: number;
}
export function project(mrr: number, input: ScenarioInput) {
  if (
    !Number.isFinite(mrr) ||
    mrr < 0 ||
    !Number.isFinite(input.monthlyGrowth) ||
    input.monthlyGrowth < -100 ||
    input.monthlyGrowth > 100 ||
    !Number.isInteger(input.months) ||
    input.months < 1 ||
    input.months > 36
  )
    throw new Error("Hypothèses invalides.");
  return Array.from({ length: input.months + 1 }, (_, month) => ({
    month,
    mrr: mrr * Math.pow(1 + input.monthlyGrowth / 100, month),
  }));
}
