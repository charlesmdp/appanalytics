import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import "@fontsource-variable/inter";
import { PERIODS, project, type Point } from "../../src/analytics";
import "./style.css";
const colors = ["#6557e8", "#19a48b"];
const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const number = (v: number) => nf.format(v);
const date = (v: string) =>
  new Date(v + "T12:00:00Z").toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const shortDate = (v: string) =>
  new Date(v + "T12:00:00Z").toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const percent = (v: number | null) =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)} %`;
const duration = (seconds: number) =>
  seconds < 60
    ? "< 1 min"
    : seconds < 3600
      ? `${Math.ceil(seconds / 60)} min`
      : seconds < 86400
        ? `${(seconds / 3600).toFixed(1)} h`
        : `${(seconds / 86400).toFixed(1)} j`;
async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data: any = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error ?? "Erreur de connexion."), {
      status: response.status,
    });
  return data;
}
function Icon({ name }: { name: string }) {
  return (
    <span className="icon" aria-hidden="true">
      {(
        {
          overview: "▦",
          scenarios: "⌁",
          sync: "↻",
          arrow: "↗",
          download: "↓",
          spark: "✧",
        } as Record<string, string>
      )[name] ?? name}
    </span>
  );
}
function App() {
  const [session, setSession] = useState<boolean | null>(null),
    [status, setStatus] = useState<any>(null),
    [data, setData] = useState<any>(null);
  const [app, setApp] = useState("all"),
    [period, setPeriod] = useState("last_30_days"),
    [currency, setCurrency] = useState(""),
    [tab, setTab] = useState("overview");
  const [start, setStart] = useState("2022-01-21"),
    [end, setEnd] = useState(new Date().toISOString().slice(0, 10)),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [action, setAction] = useState("");
  const [password, setPassword] = useState(""),
    [refresh, setRefresh] = useState(0),
    [analysis, setAnalysis] = useState(""),
    [aiBusy, setAiBusy] = useState(false),
    [page, setPage] = useState(0);
  const [months, setMonths] = useState(12),
    [growth, setGrowth] = useState(5);
  const qs = new URLSearchParams({
    app,
    period,
    ...(currency ? { currency } : {}),
    ...(period === "custom" ? { start, end } : {}),
  }).toString();
  async function loadStatus() {
    try {
      const result = await api("/api/status");
      setStatus(result);
      setSession(true);
    } catch (e: any) {
      if (e.status === 401) setSession(false);
      else setError(e.message);
    }
  }
  useEffect(() => {
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), 5000);
    return () => clearInterval(timer);
  }, []);
  const syncing = status?.apps?.some(
    (a: any) => a.status === "running" && !a.paused,
  );
  useEffect(() => {
    if (!session) return;
    let active = true;
    setLoading(true);
    setError("");
    setAnalysis("");
    setPage(0);
    api(`/api/analytics?${qs}`)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setData(null);
          if (e.status === 401) setSession(false);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session, qs, refresh]);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => setRefresh((x) => x + 1), 15000);
    return () => clearInterval(timer);
  }, [syncing]);
  const latestSuccess = status?.apps?.map((a: any) => a.last_success).join(",");
  useEffect(() => {
    if (session) setRefresh((x) => x + 1);
  }, [latestSuccess]);
  async function sync(key: string, which = "start") {
    setAction(key);
    setError("");
    try {
      await api("/api/sync", {
        method: "POST",
        body: JSON.stringify({ app: key, action: which }),
      });
      await loadStatus();
      setRefresh((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAction("");
    }
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      await loadStatus();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  const money = (v: number) => {
    try {
      return new Intl.NumberFormat("fr-FR", {
        style: "currency",
        currency: data?.currency ?? "USD",
        maximumFractionDigits: 0,
      }).format(v);
    } catch {
      return `${number(v)} ${data?.currency ?? ""}`;
    }
  };
  function exportCsv() {
    if (!data) return;
    const columns = [
      "date",
      "mrr",
      "paying",
      "installs",
      "uninstalls",
      "reactivations",
      "deactivations",
      "gross",
      "net",
    ];
    const content = [
      "# Devise : " + data.currency + " · UTC",
      columns.join(";"),
      ...data.points.map((p: any) => columns.map((k) => p[k]).join(";")),
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `penida-${app}-${data.range.start}-${data.range.end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  if (session === null)
    return (
      <div className="center">
        <div className="brand-logo">p.</div>
        <p>Connexion au dashboard…</p>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  if (!session)
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={login}>
          <div className="brand-logo">p.</div>
          <div className="eyebrow">PENIDA STUDIO</div>
          <h1>
            Vos apps.
            <br />
            Une vue d’ensemble.
          </h1>
          <p>
            Revenus, croissance et trajectoires.
            <br />
            Un espace privé pour votre portefeuille Shopify.
          </p>
          <label>
            Mot de passe
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary" disabled={loading}>
            {loading ? "Connexion…" : "Ouvrir le dashboard →"}
          </button>
          <small>Big Download · Cowlendar</small>
        </form>
        <div className="login-art">
          <div className="orb" />
          <p>
            Une meilleure lecture
            <br />
            de ce qui fait grandir
            <br />
            <em>vos apps.</em>
          </p>
          <div className="mini-bars">
            {[18, 32, 28, 44, 40, 61, 56, 75, 70, 87, 93, 110].map((h, i) => (
              <i key={i} style={{ height: h }} />
            ))}
          </div>
        </div>
      </div>
    );
  const summary = data?.summary;
  const graph =
    data?.points.map((p: Point, i: number) => ({
      ...p,
      ...Object.fromEntries(
        data.apps.map((a: any) => [a.key, a.points[i].mrr]),
      ),
    })) ?? [];
  const noHistory = status?.apps?.every(
    (a: any) => !a.last_success && a.status === "idle",
  );
  const current = data?.forecast?.mrr ?? summary?.mrr ?? 0;
  const scenarios = [
    { key: "stable", label: "Stable", rate: 0, color: "#8892a8" },
    { key: "prudent", label: "Recul", rate: -3, color: "#e58c69" },
    { key: "growth", label: "Croissance", rate: 5, color: "#19a48b" },
    { key: "custom", label: "Votre scénario", rate: growth, color: "#6557e8" },
  ];
  const forecasts = Array.from({ length: months + 1 }, (_, i) =>
    Object.fromEntries([
      ["month", i],
      ...scenarios.map((s) => [
        s.key,
        project(current, { monthlyGrowth: s.rate, months })[i]!.mrr,
      ]),
    ]),
  );
  return (
    <div className="layout">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-logo">p.</span>
          <span>
            penida<span className="brand-sub">APP ANALYTICS</span>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {[
            ["overview", "Vue d’ensemble"],
            ["scenarios", "Projections"],
            ["sync", "Synchronisation"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id!)}
            >
              <Icon name={id!} />
              {label}
              {id === "sync" && syncing && <span className="dot" />}
            </button>
          ))}
        </nav>
        <div className="nav-label apps-label">VOS APPLICATIONS</div>
        {[
          {
            key: "big-download",
            name: "Big Download",
            initial: "B",
            color: colors[0],
          },
          {
            key: "cowlendar",
            name: "Cowlendar",
            initial: "C",
            color: colors[1],
          },
        ].map((a) => (
          <button
            key={a.key}
            className="side-app"
            onClick={() => {
              setApp(a.key);
              setTab("overview");
            }}
          >
            <span style={{ background: a.color + "18", color: a.color }}>
              {a.initial}
            </span>
            {a.name}
          </button>
        ))}
        <div className="sidebar-bottom">
          <span className="privacy">● Espace privé</span>
          <small>
            Propulsé par PartnerDex
            <br />
            Adapté pour Penida Studio
          </small>
          <button
            onClick={async () => {
              await api("/api/logout", { method: "POST" });
              setSession(false);
              setData(null);
            }}
          >
            Se déconnecter ↗
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            {tab === "overview"
              ? "Vue d’ensemble"
              : tab === "scenarios"
                ? "Projections"
                : "Synchronisation"}
          </div>
          <div className="header-right">
            <span className={"dot " + (syncing ? "pulse" : "")} />
            {syncing ? "Synchronisation en cours" : "Votre portefeuille"}
            <span className="avatar">P</span>
          </div>
        </header>
        <div className="content">
          <div className="page-title">
            <div>
              <div className="eyebrow">
                {tab === "overview"
                  ? "UNE VUE CLAIRE, CHAQUE JOUR"
                  : tab === "scenarios"
                    ? "EXPLORER LES POSSIBLES"
                    : "DES DONNÉES À JOUR"}
              </div>
              <h1>
                {tab === "overview"
                  ? "Votre portefeuille, en perspective."
                  : tab === "scenarios"
                    ? "Quelle trajectoire pour vos apps ?"
                    : "Chaque étape, en toute transparence."}
              </h1>
              <p>
                {tab === "overview"
                  ? "Suivez ce qui progresse. Comprenez ce qui change."
                  : tab === "scenarios"
                    ? "Modifiez les hypothèses et comparez leur effet sur le MRR."
                    : "Un import qui peut reprendre là où il s’est arrêté."}
              </p>
            </div>
            {tab === "overview" && (
              <button
                className="secondary"
                onClick={exportCsv}
                disabled={!data}
              >
                <Icon name="download" />
                Exporter
              </button>
            )}
          </div>
          {status?.demo && (
            <div className="notice">
              Aperçu local · Données de démonstration fictives · Aucun compte
              Shopify connecté
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
              <button
                onClick={() => {
                  setRefresh((x) => x + 1);
                  void loadStatus();
                }}
              >
                Réessayer
              </button>
            </div>
          )}
          {tab !== "sync" && (
            <div className="toolbar">
              <div className="filters">
                <label className="sr-only" htmlFor="app">
                  Application
                </label>
                <select
                  id="app"
                  value={app}
                  onChange={(e) => setApp(e.target.value)}
                >
                  <option value="all">Toutes les apps</option>
                  <option value="big-download">Big Download</option>
                  <option value="cowlendar">Cowlendar</option>
                </select>
                {data?.currencies?.length > 1 && (
                  <select
                    aria-label="Devise"
                    value={data.currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    {data.currencies.map((c: string) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="periods">
                {PERIODS.map((p) => (
                  <button
                    className={period === p.id ? "selected" : ""}
                    key={p.id}
                    onClick={() => setPeriod(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  className={period === "custom" ? "selected" : ""}
                  onClick={() => setPeriod("custom")}
                >
                  Personnalisé
                </button>
              </div>
            </div>
          )}
          {period === "custom" && tab !== "sync" && (
            <div className="custom-range">
              <label>
                Du{" "}
                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label>
                Au{" "}
                <input
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
            </div>
          )}
          {tab !== "sync" && data && (
            <div className="range-meta">
              <span>
                {date(data.range.start)} — {date(data.range.end)}{" "}
                <span>· UTC · {data.currency}</span>
              </span>
              <span>
                {loading
                  ? "Actualisation…"
                  : data.complete
                    ? "Dernière synchro : " +
                      new Date(
                        data.apps
                          .map((a: any) => a.asOf)
                          .filter(Boolean)
                          .sort()[0],
                      ).toLocaleString("fr-FR")
                    : "Données incomplètes"}
                {data.range.todayPartial && " · Aujourd’hui partiel"}
              </span>
            </div>
          )}
          {noHistory && tab !== "sync" && (
            <div className="setup panel">
              <span className="setup-icon">↗</span>
              <div>
                <h2>Vos deux apps sont prêtes à être connectées.</h2>
                <p>
                  Ajoutez les deux jetons Shopify dans les secrets Cloudflare,
                  puis lancez la première synchronisation. Vos vrais chiffres
                  apparaîtront ici.
                </p>
              </div>
              <button className="primary" onClick={() => setTab("sync")}>
                Configurer l’import
              </button>
            </div>
          )}
          {!noHistory && data && !data.complete && tab !== "sync" && (
            <div className="notice">
              <span>
                ◷ Les chiffres sont provisoires pendant la synchronisation. Les
                projections attendent un calcul complet.
              </span>
              <button onClick={() => setTab("sync")}>
                Voir la progression →
              </button>
            </div>
          )}
          {tab === "overview" && summary && !noHistory && (
            <>
              <section className="cards">
                <Metric
                  label="MRR en fin de période"
                  value={money(summary.mrr)}
                  change={percent(summary.mrrGrowth)}
                  positive={summary.mrrChange >= 0}
                  detail={`${money(summary.mrrChange)} sur la période`}
                  accent
                />
                <Metric
                  label="Installations"
                  value={number(summary.installs)}
                  change={`${summary.installs - summary.uninstalls >= 0 ? "+" : ""}${number(summary.installs - summary.uninstalls)} net`}
                  positive={summary.installs >= summary.uninstalls}
                  detail="Installations − désinstallations"
                />
                <Metric
                  label="Désinstallations"
                  value={number(summary.uninstalls)}
                  detail="Retraits de l’app par les boutiques"
                />
                <Metric
                  label="Revenus bruts"
                  value={money(summary.gross)}
                  detail="Transactions enregistrées · hors MRR"
                />
              </section>
              <section className="panel chart-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">REVENUS RÉCURRENTS</div>
                    <h2>Le MRR, jour après jour</h2>
                    <p>
                      Abonnements annuels répartis sur 12 mois · essais et usage
                      exclus
                    </p>
                  </div>
                  <div className="chart-badge">Quotidien</div>
                </div>
                <div className="big-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={graph}
                      margin={{ top: 12, right: 10, left: 6, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="mrrFill"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#6557e8"
                            stopOpacity={0.18}
                          />
                          <stop
                            offset="100%"
                            stopColor="#6557e8"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="#edf0f6" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={shortDate}
                        minTickGap={55}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tickFormatter={(v) => number(v)}
                        width={65}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        labelFormatter={(v) => date(String(v))}
                        formatter={(v: number) => money(v)}
                      />
                      <Area
                        type="monotone"
                        dataKey="mrr"
                        name="MRR total"
                        stroke="#6557e8"
                        strokeWidth={2.5}
                        fill="url(#mrrFill)"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
              <div className="two-columns">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">ACQUISITION & DÉPARTS</div>
                      <h2>Le mouvement quotidien</h2>
                    </div>
                  </div>
                  <div className="medium-chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={graph}>
                        <CartesianGrid vertical={false} stroke="#edf0f6" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={shortDate}
                          minTickGap={55}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis width={42} axisLine={false} tickLine={false} />
                        <Tooltip labelFormatter={(v) => date(String(v))} />
                        <Legend />
                        <Bar
                          dataKey="installs"
                          name="Installations"
                          fill="#6557e8"
                          radius={[3, 3, 0, 0]}
                          isAnimationActive={false}
                        />
                        <Bar
                          dataKey="uninstalls"
                          name="Désinstallations"
                          fill="#e8a58c"
                          radius={[3, 3, 0, 0]}
                          isAnimationActive={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="footnote">
                    {number(summary.reactivations)} réactivations et{" "}
                    {number(summary.deactivations)} désactivations de boutiques,
                    comptées séparément.
                  </p>
                </section>
                <section className="panel app-panel">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">CONTRIBUTION</div>
                      <h2>Chaque app compte</h2>
                    </div>
                  </div>
                  {data.apps.map((a: any) => (
                    <div key={a.key} className="app-contribution">
                      <div className="app-row">
                        <span
                          className="app-avatar"
                          style={{ background: a.color + "18", color: a.color }}
                        >
                          {a.name[0]}
                        </span>
                        <div>
                          <strong>{a.name}</strong>
                          <small>
                            {number(a.summary.paying)} boutiques payantes
                          </small>
                        </div>
                        <div className="app-amount">
                          <strong>{money(a.summary.mrr)}</strong>
                          <small
                            className={
                              a.summary.mrrChange >= 0 ? "positive" : "negative"
                            }
                          >
                            {percent(a.summary.mrrGrowth)}
                          </small>
                        </div>
                      </div>
                      <div className="contribution-track">
                        <i
                          style={{
                            width: `${summary.mrr > 0 ? (a.summary.mrr / summary.mrr) * 100 : 0}%`,
                            background: a.color,
                          }}
                        />
                      </div>
                      <div className="app-facts">
                        <span>{number(a.summary.installs)} installs</span>
                        <span>{number(a.summary.uninstalls)} départs</span>
                        <span>
                          {summary.mrr > 0
                            ? ((a.summary.mrr / summary.mrr) * 100).toFixed(1)
                            : "0"}{" "}
                          % du MRR
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="quiet-callout">
                    Une boutique abonnée aux deux apps compte une fois pour
                    chaque app.
                  </div>
                </section>
              </div>
              <section className="panel insights">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">PRENDRE DU RECUL</div>
                    <h2>
                      <Icon name="spark" /> Ce que disent les chiffres
                    </h2>
                  </div>
                  <button
                    className="secondary"
                    disabled={!data.complete || aiBusy || !status.aiEnabled}
                    title={
                      !status.aiEnabled
                        ? "Activer AI_ENABLED dans Cloudflare pour utiliser Workers AI"
                        : undefined
                    }
                    onClick={async () => {
                      setAiBusy(true);
                      setError("");
                      try {
                        const r = await api(`/api/insights?${qs}`, {
                          method: "POST",
                        });
                        setAnalysis(r.text);
                      } catch (e: any) {
                        setError(e.message);
                      } finally {
                        setAiBusy(false);
                      }
                    }}
                  >
                    {aiBusy ? "Analyse…" : "Analyser avec l’IA ↗"}
                  </button>
                </div>
                <div className="insight-grid">
                  {data.insights.map((s: string, i: number) => (
                    <div key={s}>
                      <span>0{i + 1}</span>
                      <p>{s}</p>
                    </div>
                  ))}
                </div>
                {analysis && (
                  <div className="ai-output">
                    <span className="eyebrow">ANALYSE IA · À INTERPRÉTER</span>
                    <p>{analysis}</p>
                  </div>
                )}
                <p className="footnote">
                  {status.aiEnabled
                    ? "L’IA reçoit uniquement des chiffres agrégés. Elle propose des interprétations, pas des certitudes."
                    : "Observations calculées automatiquement. L’analyse IA est optionnelle et nécessite Workers AI."}
                </p>
              </section>
              <section className="panel table-panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">DANS LE DÉTAIL</div>
                    <h2>Le journal de votre croissance</h2>
                  </div>
                  <button className="text-button" onClick={exportCsv}>
                    Télécharger le CSV ↓
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Jour · UTC</th>
                        <th>MRR</th>
                        <th>Installations</th>
                        <th>Désinstallations</th>
                        <th>Solde</th>
                        <th>Revenus bruts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.points]
                        .reverse()
                        .slice(page * 14, (page + 1) * 14)
                        .map((p: Point) => (
                          <tr key={p.date}>
                            <td>{date(p.date)}</td>
                            <td>{money(p.mrr)}</td>
                            <td>{number(p.installs)}</td>
                            <td>{number(p.uninstalls)}</td>
                            <td
                              className={
                                p.installs >= p.uninstalls
                                  ? "positive"
                                  : "negative"
                              }
                            >
                              {p.installs - p.uninstalls >= 0 ? "+" : ""}
                              {number(p.installs - p.uninstalls)}
                            </td>
                            <td>{money(p.gross)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>
                    {data.points.length} jours · Page {page + 1} /{" "}
                    {Math.max(1, Math.ceil(data.points.length / 14))}
                  </span>
                  <div>
                    <button
                      disabled={page === 0}
                      onClick={() => setPage((x) => x - 1)}
                    >
                      ← Précédent
                    </button>
                    <button
                      disabled={(page + 1) * 14 >= data.points.length}
                      onClick={() => setPage((x) => x + 1)}
                    >
                      Suivant →
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
          {tab === "scenarios" && (
            <>
              <div className="notice">
                Les courbes sont des simulations mathématiques. « Stable »
                signifie un MRR constant, même si des abonnements arrivent et
                partent.
              </div>
              {!data?.complete ? (
                <div className="panel setup">
                  <h2>
                    Les projections seront disponibles après un import complet.
                  </h2>
                  <button className="primary" onClick={() => setTab("sync")}>
                    Voir la synchronisation
                  </button>
                </div>
              ) : (
                <>
                  <div className="scenario-controls panel">
                    <div>
                      <span className="eyebrow">POINT DE DÉPART</span>
                      <strong>
                        {money(current)} <small>de MRR</small>
                      </strong>
                      <p>
                        Dernier état synchronisé{" "}
                        {data.forecast?.asOf
                          ? new Date(data.forecast.asOf).toLocaleDateString(
                              "fr-FR",
                            )
                          : ""}
                        , indépendant de la période affichée.
                      </p>
                    </div>
                    <label>
                      Horizon
                      <select
                        value={months}
                        onChange={(e) => setMonths(Number(e.target.value))}
                      >
                        <option value={6}>6 mois</option>
                        <option value={12}>12 mois</option>
                        <option value={24}>24 mois</option>
                        <option value={36}>36 mois</option>
                      </select>
                    </label>
                    <label>
                      Votre croissance nette mensuelle{" "}
                      <strong>{percent(growth)}</strong>
                      <input
                        type="range"
                        min={-20}
                        max={20}
                        step={0.5}
                        value={growth}
                        onChange={(e) => setGrowth(Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <div>
                        <div className="eyebrow">QUATRE HYPOTHÈSES</div>
                        <h2>
                          Une décision aujourd’hui, un effet dans le temps.
                        </h2>
                      </div>
                    </div>
                    <div className="big-chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={forecasts}>
                          <CartesianGrid vertical={false} stroke="#edf0f6" />
                          <XAxis
                            dataKey="month"
                            tickFormatter={(n) => `M+${n}`}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            width={70}
                            tickFormatter={(v) => number(v)}
                            axisLine={false}
                            tickLine={false}
                          />
                          <Tooltip
                            labelFormatter={(v) => `Dans ${v} mois`}
                            formatter={(v: number) => money(v)}
                          />
                          <Legend />
                          {scenarios.map((s) => (
                            <Line
                              key={s.key}
                              type="monotone"
                              dataKey={s.key}
                              name={`${s.label} (${percent(s.rate)}/mois)`}
                              stroke={s.color}
                              strokeWidth={s.key === "custom" ? 3 : 2}
                              dot={false}
                              strokeDasharray={
                                s.key === "stable" ? "5 5" : undefined
                              }
                              isAnimationActive={false}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </section>
                  <div className="cards">
                    {scenarios.map((s) => (
                      <Metric
                        key={s.key}
                        label={`${s.label} · ${percent(s.rate)}/mois`}
                        value={money(
                          project(current, {
                            monthlyGrowth: s.rate,
                            months,
                          }).at(-1)!.mrr,
                        )}
                        detail={`MRR à ${months} mois`}
                        accent={s.key === "custom"}
                      />
                    ))}
                  </div>
                  <section className="panel methodology">
                    <h2>Des hypothèses visibles.</h2>
                    <p>
                      MRR futur = MRR actuel × (1 + croissance nette mensuelle)
                      <sup>nombre de mois</sup>. La croissance nette rassemble
                      les nouveaux abonnements, les départs, les upgrades et les
                      downgrades.
                    </p>
                    <p>
                      Le scénario « recul » utilise −3 % par mois ; « croissance
                      » utilise +5 %. Ces valeurs sont des hypothèses
                      illustratives modifiables via votre scénario. Elles ne
                      sont pas une prévision entraînée sur vos apps. Le modèle
                      ne simule ni saisonnalité, ni changement de prix, ni
                      limite de marché.
                    </p>
                  </section>
                </>
              )}
            </>
          )}
          {tab === "sync" && (
            <>
              <div className="sync-top">
                <p>
                  Les données sont sauvegardées après chaque page. Vous pouvez
                  fermer cet onglet.
                </p>
                <button
                  className="primary"
                  disabled={
                    Boolean(action) ||
                    !status?.apps?.every((a: any) => a.configured)
                  }
                  onClick={() => sync("all")}
                >
                  Synchroniser les deux apps ↻
                </button>
              </div>
              {status?.apps?.map((s: any) => (
                <SyncCard
                  key={s.app}
                  status={s}
                  busy={action === s.app || action === "all"}
                  onAction={(which) => sync(s.app, which)}
                />
              ))}
              <section className="panel methodology">
                <h2>Un temps restant honnête.</h2>
                <p>
                  L’API Shopify ne donne pas le nombre total de paiements à
                  importer. La progression d’import mesure donc les fenêtres de
                  calendrier terminées, pas un pourcentage de transactions. Les
                  périodes récentes peuvent contenir beaucoup plus de données.
                </p>
                <p>
                  Après trois fenêtres terminées, une fourchette de durée est
                  estimée à partir du temps réellement observé. Elle couvre
                  l’import uniquement. Ensuite, le nombre de boutiques à
                  calculer devient connu et une estimation distincte apparaît.
                </p>
                <p>
                  Un Cron vérifie le travail toutes les 15 minutes. Une file de
                  tâches enchaîne les lots pendant le premier import. Les
                  erreurs temporaires déclenchent des reprises ; les erreurs
                  persistantes restent visibles.
                </p>
              </section>
            </>
          )}
          <footer>
            Penida Studio <span>·</span> Les revenus bruts sont des flux. Le MRR
            est un niveau mensuel. <span>·</span> UTC
          </footer>
        </div>
      </main>
    </div>
  );
}
function Metric({
  label,
  value,
  change,
  positive,
  detail,
  accent,
}: {
  label: string;
  value: string;
  change?: string;
  positive?: boolean;
  detail: string;
  accent?: boolean;
}) {
  return (
    <article className={"metric " + (accent ? "accent" : "")}>
      <div className="metric-label">
        {label}
        <span>↗</span>
      </div>
      <strong>{value}</strong>
      <div className="metric-bottom">
        {change && (
          <span className={"change " + (positive ? "positive" : "negative")}>
            {change}
          </span>
        )}
        <small>{detail}</small>
      </div>
    </article>
  );
}
function SyncCard({
  status: s,
  busy,
  onAction,
}: {
  status: any;
  busy: boolean;
  onAction: (action: string) => void;
}) {
  const importing = ["transactions", "events"].includes(s.phase);
  const title =
    (
      {
        idle: "Prêt à démarrer",
        complete: "À jour",
        error: "Action nécessaire",
        running: s.paused ? "En pause" : "En cours",
      } as Record<string, string>
    )[s.status] ?? s.status;
  const phase = (
    {
      transactions: "Import des paiements",
      events: "Import des événements",
      pricing: "Identification des forfaits",
      expanding: "Préparation du recalcul",
      deriving: "Calcul des historiques",
      complete: "Synchronisation terminée",
    } as Record<string, string>
  )[s.phase];
  const progress = importing ? s.calendarPercent : s.phasePercent;
  return (
    <section className="panel sync-card">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">
            {s.app === "big-download"
              ? "PARTNER 655806 · APP 6922231"
              : "PARTNER 4386727 · APP 5822535"}
          </div>
          <h2>{s.name}</h2>
        </div>
        <span
          className={"status-badge " + (s.status === "error" ? "warning" : "")}
        >
          {s.configured ? title : "Jeton manquant"}
        </span>
      </div>
      <div className="sync-stage">
        <strong>
          {s.status === "idle" ? "Aucun historique importé" : phase}
        </strong>
        <span>
          {s.status === "complete"
            ? "100 %"
            : s.status === "idle"
              ? "—"
              : progress !== null
                ? `${progress} % ${importing ? "du calendrier" : "de cette étape"}`
                : "Mesure en cours"}
        </span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={importing ? "Calendrier parcouru" : "Boutiques calculées"}
        aria-valuenow={s.status === "complete" ? 100 : (progress ?? undefined)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i
          style={{
            width: `${s.status === "complete" ? 100 : (progress ?? 0)}%`,
          }}
        />
      </div>
      <div className="sync-stats">
        <div>
          <span>Lignes reçues</span>
          <strong>{number(s.records)}</strong>
        </div>
        <div>
          <span>Pages enregistrées</span>
          <strong>{number(s.pages)}</strong>
        </div>
        <div>
          <span>{importing ? "Fenêtres terminées" : "Boutiques traitées"}</span>
          <strong>
            {importing
              ? `${s.windows_done} / ${s.windows_total}`
              : `${s.units_done} / ${s.units_total}`}
          </strong>
        </div>
        <div>
          <span>Temps restant estimé</span>
          <strong>
            {s.eta
              ? `${duration(s.eta.low)} – ${duration(s.eta.high)}`
              : s.status === "complete"
                ? "Terminé"
                : "Pas encore estimable"}
          </strong>
          {s.eta && <small>{s.eta.scope}</small>}
        </div>
      </div>
      {s.status === "running" && importing && (
        <p className="footnote">
          Fenêtre en cours : {date(s.window_start.slice(0, 10))} →{" "}
          {date(s.window_end.slice(0, 10))} · Débit moyen{" "}
          {s.recordsPerSecond?.toFixed(1) ?? "—"} lignes/s (relectures
          comprises)
        </p>
      )}
      {s.last_success && (
        <p className="footnote">
          Données synchronisées jusqu’au{" "}
          {new Date(s.last_success).toLocaleString("fr-FR")}.
        </p>
      )}
      {s.error && (
        <div className="error" role="alert">
          {s.error}
          {s.retry_at > Date.now() &&
            ` Reprise après ${new Date(s.retry_at).toLocaleTimeString("fr-FR")}.`}
        </div>
      )}
      {s.stale && (
        <div className="notice">
          Aucune progression récente. Le Cron tentera de relancer le travail ;
          vous pouvez aussi cliquer sur Reprendre.
        </div>
      )}
      {!s.configured && (
        <div className="quiet-callout">
          Ajoutez{" "}
          <code>
            {s.app === "big-download"
              ? "PARTNER_TOKEN_BIG_DOWNLOAD"
              : "PARTNER_TOKEN_COWLENDAR"}
          </code>{" "}
          aux secrets du Worker Cloudflare.
        </div>
      )}
      <div className="sync-actions">
        <button
          className="primary"
          disabled={!s.configured || busy}
          onClick={() =>
            onAction(s.status === "running" && !s.paused ? "pause" : "start")
          }
        >
          {busy
            ? "Enregistrement…"
            : s.status === "running" && !s.paused
              ? "Mettre en pause"
              : s.status === "error" || s.paused
                ? "Reprendre"
                : "Synchroniser"}
        </button>
        {s.status === "complete" && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => onAction("full")}
          >
            Relire tout l’historique
          </button>
        )}
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
