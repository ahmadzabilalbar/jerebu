/**
 * JEREBU WATCH — hourly Air Pollutant Index (IPU / Indeks Pencemaran Udara) dashboard
 * for Alor Setar (Kedah) & Kangar (Perlis), Malaysia.
 *
 * ─── DATA SOURCE (official) ──────────────────────────────────────────────────────
 * Jabatan Alam Sekitar (DOE) APIMS, the same feeds that power eqms.doe.gov.my/APIMS:
 *   • Current reading per station (ArcGIS layer):
 *     /api3/publicmapproxy/PUBLIC_DISPLAY/CAQM_MCAQM_Current_Reading/MapServer/0/query
 *   • Hourly history, 24 h window per state, ~7 days retained by DOE:
 *     /api3/publicportalapims/datatrendchart?stateid=<id>&datetime=YYYY-MM-DDTHH:00:00
 * DOE sends CORS headers for its own site only, so every fetch runs server-side here.
 * Each location reads its own DOE station directly: Alor Setar = CA03K, Kangar = CA01R.
 *
 * ─── LONG-TERM ARCHIVE (Supabase) ────────────────────────────────────────────────
 * DOE only keeps ~7 days. With Supabase connected, every page load (at most once per
 * 30 min per server instance) upserts the last 7 days of hourly readings, so the archive
 * stays gap-free as long as the page is opened (or the cron runs) at least once a week.
 * vercel.json runs a daily cron on "/" to guarantee that, which also works on Vercel Hobby.
 * Unlocks the 30-day (hourly), 90-day and 1-year (daily peak/avg/min) ranges.
 *
 * Run once in the Supabase SQL editor:
 *
 *   create table if not exists public.ipu_readings (
 *     station_id  text        not null,
 *     recorded_at timestamptz not null,
 *     ipu         integer     not null,
 *     tag         text        not null,
 *     inserted_at timestamptz not null default now(),
 *     primary key (station_id, recorded_at)
 *   );
 *   alter table public.ipu_readings enable row level security; -- no policies: server key only
 *
 *   create or replace view public.ipu_daily with (security_invoker = true) as
 *   select station_id,
 *          (recorded_at at time zone 'Asia/Kuala_Lumpur')::date as day,
 *          max(ipu)                as max_ipu,
 *          round(avg(ipu))::int    as avg_ipu,
 *          min(ipu)                as min_ipu,
 *          count(*)::int           as hours
 *   from public.ipu_readings
 *   group by station_id, day;
 *
 * Env vars (server-only, never NEXT_PUBLIC_):
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<sb_secret_… or legacy service_role key>
 *
 * ─── DEPLOY ──────────────────────────────────────────────────────────────────────
 *   npm i && npm run dev        → http://localhost:3000
 *   push to GitHub → import in Vercel → (optional) add the two env vars → deploy.
 */
import { after } from "next/server";

export const dynamic = "force-dynamic";

/* ═══════════════════════════════ CONFIG ═══════════════════════════════ */

/** Monitored locations, each tied to its own official DOE station.
 *  stateId comes from DOE's /publicportalapims/statelist. */
const AREAS = [
  { key: "alor-setar", name: "Alor Setar", note: "Kedah", stationId: "CA03K", stateId: 2, stateName: "Kedah" },
  { key: "kangar", name: "Kangar", note: "Perlis", stationId: "CA01R", stateId: 9, stateName: "Perlis" },
] as const;

const STATES = [...new Map(AREAS.map((a) => [a.stateId, { id: a.stateId, name: a.stateName }])).values()];

/** `daily` ranges are served from the archive's ipu_daily view (one bar = one day's peak). */
const RANGES = [
  { key: "24", hours: 24, label: "24 h", archive: false, daily: false },
  { key: "72", hours: 72, label: "3 days", archive: false, daily: false },
  { key: "168", hours: 168, label: "7 days", archive: false, daily: false },
  { key: "720", hours: 720, label: "30 days", archive: true, daily: false },
  { key: "2160", hours: 2160, label: "90 days", archive: true, daily: true },
  { key: "8760", hours: 8760, label: "1 year", archive: true, daily: true },
] as const;
type Range = (typeof RANGES)[number];

/** DOE IPU rating scale (Indeks Pencemaran Udara). */
const TAGS = [
  {
    key: "good", en: "Good", ms: "Baik", min: 0, max: 50, color: "#2563eb",
    badge: "bg-blue-50 text-blue-800 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/30",
    advice: "Low pollution. No ill effects on health.",
  },
  {
    key: "moderate", en: "Moderate", ms: "Sederhana", min: 51, max: 100, color: "#16a34a",
    badge: "bg-green-50 text-green-800 ring-green-200 dark:bg-green-500/15 dark:text-green-200 dark:ring-green-400/30",
    advice: "Moderate pollution. No ill effects for healthy people.",
  },
  {
    key: "unhealthy", en: "Unhealthy", ms: "Tidak Sihat", min: 101, max: 200, color: "#eab308",
    badge: "bg-yellow-50 text-yellow-900 ring-yellow-300 dark:bg-yellow-400/15 dark:text-yellow-200 dark:ring-yellow-400/30",
    advice: "Mild aggravation for people with heart or lung disease. Reduce prolonged outdoor exertion.",
  },
  {
    key: "very-unhealthy", en: "Very Unhealthy", ms: "Sangat Tidak Sihat", min: 201, max: 300, color: "#ea580c",
    badge: "bg-orange-50 text-orange-900 ring-orange-300 dark:bg-orange-500/15 dark:text-orange-200 dark:ring-orange-400/30",
    advice: "Significant aggravation. Children, the elderly and those with heart or lung disease should stay indoors.",
  },
  {
    key: "hazardous", en: "Hazardous", ms: "Berbahaya", min: 301, max: Infinity, color: "#dc2626",
    badge: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/30",
    advice: "Serious risk. Everyone should avoid outdoor activity and keep doors and windows closed.",
  },
] as const;

type Tag = (typeof TAGS)[number];
const tagOf = (ipu: number): Tag => TAGS.find((t) => ipu <= t.max) ?? TAGS[TAGS.length - 1];

const DOE = "https://eqms.doe.gov.my/api3";
const SB_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ARCHIVE_ON = Boolean(SB_URL && SB_KEY);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MYT_OFFSET = 8 * HOUR;

/* ═══════════════════════════════ TYPES & UTILS ═══════════════════════════════ */

type Station = {
  id: string; location: string; place: string; state: string;
  ipu: number | null; pollutant: string | null; time: Date | null;
};
/** One bar. Hourly: ipu = that hour. Daily: ipu = the day's peak, plus avg/min/hours. */
type Reading = { stationId: string; time: Date; ipu: number; avg?: number; min?: number; hours?: number };
type Search = { area: string; range: string; tag: string };

/** "YYYY-MM-DDTHH:00:00" in Malaysia time (DOE's wire format). */
const toMytHour = (d: Date) => new Date(d.getTime() + MYT_OFFSET).toISOString().slice(0, 13) + ":00:00";
const fromMyt = (s: string) => new Date(`${s.slice(0, 19)}+08:00`);
/** Request time, read once per render (kept out of components for render purity). */
const currentHour = () => Math.floor(Date.now() / HOUR) * HOUR;
/** Start of the Malaysia-time day containing `ms`. */
const mytDayStart = (ms: number) => Math.floor((ms + MYT_OFFSET) / DAY) * DAY - MYT_OFFSET;
const mytHourOf = (d: Date) => new Date(d.getTime() + MYT_OFFSET).getUTCHours();
const mytDateOf = (d: Date) => new Date(d.getTime() + MYT_OFFSET).getUTCDate();

const fmt = (d: Date, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", hour12: false, ...o }).format(d);
const fmtTime = (d: Date) => fmt(d, { hour: "2-digit", minute: "2-digit" });
const fmtDayTime = (d: Date) => fmt(d, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDate = (d: Date) => fmt(d, { day: "2-digit", month: "short", year: "numeric" });
const fmtWhen = (d: Date, daily: boolean) => (daily ? fmtDate(d) : fmtDayTime(d));

/** X-axis label for a slot, or null for no label. */
function tickLabel(range: Range, t: Date): string | null {
  const hh = mytHourOf(t), dd = mytDateOf(t);
  switch (range.key) {
    case "24": return hh % 3 === 0 ? fmtTime(t) : null;
    case "72": return hh % 12 === 0 ? fmtTime(t) : null;
    case "168": return hh === 0 ? fmt(t, { day: "2-digit", month: "short" }) : null;
    case "720": return hh === 0 && [1, 8, 15, 22].includes(dd) ? fmt(t, { day: "2-digit", month: "short" }) : null;
    case "2160": return dd === 1 || dd === 15 ? fmt(t, { day: "2-digit", month: "short" }) : null;
    default: return dd === 1 ? fmt(t, { month: "short", year: "2-digit" }) : null;
  }
}

/** GET a DOE endpoint with one retry (DOE occasionally drops requests under load). */
async function doe<T>(path: string, revalidate: number, attempts = 2): Promise<T> {
  try {
    const res = await fetch(DOE + path, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (JerebuWatch dashboard)" },
      next: { revalidate },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`DOE responded ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if (attempts > 1) return doe<T>(path, revalidate, attempts - 1);
    throw e;
  }
}

/** Run async tasks with at most `limit` in flight, so DOE isn't hit with a burst. */
async function pool<T>(tasks: (() => Promise<T>)[], limit = 4): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/* ═══════════════════════════════ DOE DATA ═══════════════════════════════ */

async function getStations(): Promise<Station[]> {
  const where = encodeURIComponent(`STATION_ID IN (${AREAS.map((a) => `'${a.stationId}'`).join(",")})`);
  type Feature = { attributes: Record<string, string | number | null> };
  const data = await doe<{ features?: Feature[] }>(
    `/publicmapproxy/PUBLIC_DISPLAY/CAQM_MCAQM_Current_Reading/MapServer/0/query?where=${where}&outFields=*&returnGeometry=false&f=json`,
    300,
  );
  return (data.features ?? []).map(({ attributes: a }) => ({
    id: String(a.STATION_ID),
    location: String(a.STATION_LOCATION ?? a.STATION_ID).split(",")[0],
    place: String(a.PLACE ?? ""),
    state: String(a.STATE_NAME ?? ""),
    ipu: typeof a.API === "number" && a.API >= 0 ? Math.round(a.API) : null,
    pollutant: a.PARAM_SELECTED ? String(a.PARAM_SELECTED) : null,
    // DOE stores local (MYT) wall-clock time as if it were UTC epoch.
    time: typeof a.DATETIME === "number" ? new Date(a.DATETIME - MYT_OFFSET) : null,
  }));
}

/** Hourly IPU for the monitored stations, covering `hours` back from now (DOE keeps ~7 days). */
async function getDoeHistory(hours: number): Promise<Reading[]> {
  const now = new Date();
  const windows = Math.ceil(Math.min(hours, 168) / 24);
  const wanted = new Set<string>(AREAS.map((a) => a.stationId));
  type Row = { STATION_ID: string; DATETIME: string; API: number | null };
  const tasks = STATES.flatMap((st) =>
    Array.from({ length: windows }, (_, k) => () =>
      doe<{ highcharts_bar?: Row[] }>(
        `/publicportalapims/datatrendchart?stateid=${st.id}&datetime=${toMytHour(new Date(now.getTime() - k * DAY))}&`,
        k === 0 ? 300 : 21_600, // the newest window changes hourly; older windows are final
      ).then((d) => d.highcharts_bar ?? []).catch(() => [] as Row[]),
    ),
  );
  const seen = new Map<string, Reading>();
  for (const row of (await pool(tasks)).flat()) {
    if (!wanted.has(row.STATION_ID) || typeof row.API !== "number" || row.API < 0) continue;
    seen.set(`${row.STATION_ID}|${row.DATETIME}`, { stationId: row.STATION_ID, time: fromMyt(row.DATETIME), ipu: Math.round(row.API) });
  }
  return [...seen.values()];
}

/* ═══════════════════════════════ SUPABASE ARCHIVE (PostgREST, no SDK) ═══════════════════════════════ */

// Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys go in apikey only.
const sbHeaders = (): Record<string, string> => ({
  apikey: SB_KEY!,
  "Content-Type": "application/json",
  ...(SB_KEY!.startsWith("eyJ") ? { Authorization: `Bearer ${SB_KEY}` } : {}),
});

async function sbGet<T>(path: string, revalidate = 300): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders(), next: { revalidate } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

let lastSyncAt = 0;

/** Upsert the last 7 days from DOE. Idempotent; throttled per server instance; retries on failure. */
async function syncArchive() {
  if (!ARCHIVE_ON || Date.now() - lastSyncAt < 30 * 60_000) return;
  lastSyncAt = Date.now();
  try {
    const rows = await getDoeHistory(168);
    if (rows.length === 0) throw new Error("DOE returned no history");
    const res = await fetch(`${SB_URL}/rest/v1/ipu_readings?on_conflict=station_id,recorded_at`, {
      method: "POST",
      cache: "no-store",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.map((r) => ({ station_id: r.stationId, recorded_at: r.time.toISOString(), ipu: r.ipu, tag: tagOf(r.ipu).key }))),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    lastSyncAt = 0;
    console.error("Archive sync failed:", e);
  }
}

/** Hourly rows since `since`, paged past PostgREST's 1000-row cap. */
async function readHourly(stationId: string, since: Date): Promise<Reading[]> {
  const out: Reading[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet<{ recorded_at: string; ipu: number }[]>(
      `ipu_readings?select=recorded_at,ipu&station_id=eq.${encodeURIComponent(stationId)}&recorded_at=gte.${since.toISOString()}&order=recorded_at.asc&limit=1000&offset=${offset}`,
    );
    out.push(...page.map((r) => ({ stationId, time: new Date(r.recorded_at), ipu: r.ipu })));
    if (page.length < 1000) return out;
  }
}

/** Daily peak/avg/min from the ipu_daily view. */
async function readDaily(stationId: string, since: Date): Promise<Reading[]> {
  const rows = await sbGet<{ day: string; max_ipu: number; avg_ipu: number; min_ipu: number; hours: number }[]>(
    `ipu_daily?select=day,max_ipu,avg_ipu,min_ipu,hours&station_id=eq.${encodeURIComponent(stationId)}&day=gte.${toMytHour(since).slice(0, 10)}&order=day.asc&limit=1000`,
  );
  return rows.map((r) => ({ stationId, time: fromMyt(`${r.day}T00:00:00`), ipu: r.max_ipu, avg: r.avg_ipu, min: r.min_ipu, hours: r.hours }));
}

type ArchiveStatus = { total: number; since: Date | null } | { error: string };

async function archiveStatus(): Promise<ArchiveStatus | null> {
  if (!ARCHIVE_ON) return null;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/ipu_readings?select=recorded_at&order=recorded_at.asc&limit=1`, {
      headers: { ...sbHeaders(), Prefer: "count=exact" },
      next: { revalidate: 600 },
    });
    if (!res.ok) return { error: `Supabase ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const [first] = (await res.json()) as { recorded_at: string }[];
    return { total: Number(res.headers.get("content-range")?.split("/")[1] ?? 0), since: first ? new Date(first.recorded_at) : null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/* ═══════════════════════════════ PAGE ═══════════════════════════════ */

export default async function Page({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const ranges = RANGES.filter((r) => !r.archive || ARCHIVE_ON);
  const s: Search = {
    area: AREAS.some((a) => a.key === one(sp.area)) ? one(sp.area) : AREAS[0].key,
    range: ranges.some((r) => r.key === one(sp.range)) ? one(sp.range) : "24",
    tag: TAGS.some((t) => t.key === one(sp.tag)) ? one(sp.tag) : "",
  };
  const range = ranges.find((r) => r.key === s.range)!;
  const daily = range.daily;
  const unit = daily ? "d" : "h";

  let stations: Station[] = [];
  let history: Reading[] = [];
  let error: string | null = null;
  const statusPromise = archiveStatus();
  try {
    [stations, history] = await Promise.all([getStations(), getDoeHistory(Math.min(range.hours, 168))]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }
  after(syncArchive);

  const areaInfo = AREAS.map((area) => {
    const station = stations.find((st) => st.id === area.stationId) ?? null;
    const series = history.filter((r) => r.stationId === area.stationId).sort((a, b) => +a.time - +b.time);
    // DOE's history feed can trail the live layer by a few minutes, so append the live reading if it's newer.
    if (station?.ipu != null && station.time && (!series.length || +station.time > +series.at(-1)!.time)) {
      series.push({ stationId: area.stationId, time: station.time, ipu: station.ipu });
    }
    const last = series.at(-1);
    // Live layer first; fall back to the newest history point if the live layer is late.
    const ipu = station?.ipu ?? last?.ipu ?? null;
    const time = station?.time ?? last?.time ?? null;
    return { area, station, series, ipu, time };
  });

  const sel = areaInfo.find((a) => a.area.key === s.area)!;
  const step = daily ? DAY : HOUR;
  const slots = daily ? range.hours / 24 : range.hours;
  const nowHour = currentHour();
  const end = daily ? mytDayStart(nowHour) : nowHour;
  const since = new Date(end - (slots - 1) * step);

  let series: Reading[] = sel.series.filter((r) => r.time >= since);
  let archiveError: string | null = null;
  if (range.archive) {
    try {
      if (daily) {
        series = await readDaily(sel.area.stationId, since);
      } else {
        const merged = new Map<number, Reading>();
        for (const r of [...(await readHourly(sel.area.stationId, since)), ...series]) merged.set(+r.time, r);
        series = [...merged.values()].sort((a, b) => +a.time - +b.time);
      }
    } catch (e) {
      archiveError = e instanceof Error ? e.message : String(e);
    }
  }
  const status = await statusPromise;

  const latestTime = areaInfo.map((a) => a.time).filter((t): t is Date => !!t).sort((a, b) => +b - +a)[0];
  const peak = series.reduce<Reading | null>((m, r) => (!m || r.ipu > m.ipu ? r : m), null);
  const low = series.reduce<Reading | null>((m, r) => (!m || (r.min ?? r.ipu) < (m.min ?? m.ipu) ? r : m), null);
  const weight = (r: Reading) => r.hours ?? 1;
  const totalWeight = series.reduce((a, r) => a + weight(r), 0);
  const avg = totalWeight ? Math.round(series.reduce((a, r) => a + (r.avg ?? r.ipu) * weight(r), 0) / totalWeight) : null;
  const counts = TAGS.map((t) => ({ tag: t, n: series.filter((r) => tagOf(r.ipu).key === t.key).length }));
  const tableRows = [...series].reverse().filter((r) => !s.tag || tagOf(r.ipu).key === s.tag);

  const href = (over: Partial<Search>) => {
    const p = new URLSearchParams(Object.entries({ ...s, ...over }).filter(([, v]) => v) as [string, string][]);
    return `?${p.toString()}`;
  };

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <meta httpEquiv="refresh" content="600" />
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        {/* ─── Header ─── */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Jerebu Watch · Kedah &amp; Perlis</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Air Pollutant Index (IPU)</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Alor Setar · Kangar, updated hourly from official DOE stations</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
            </span>
            {latestTime ? <>DOE reading at <b className="font-semibold text-slate-900 dark:text-slate-100">{fmtDayTime(latestTime)}</b> MYT</> : "Waiting for data"}
          </div>
        </header>

        {error && (
          <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            Could not reach DOE APIMS ({error}). Data will reappear automatically when the service is back.
          </div>
        )}

        {/* ─── Area cards ─── */}
        <section className="mt-6 grid gap-4 md:grid-cols-2" aria-label="Current IPU by area">
          {areaInfo.map(({ area, station, ipu, series: ser }) => {
            const tag = ipu !== null ? tagOf(ipu) : null;
            const active = area.key === s.area;
            const prev = ser.at(-2)?.ipu;
            const delta = ipu !== null && prev !== undefined ? ipu - prev : null;
            return (
              <a
                key={area.key}
                href={href({ area: area.key, tag: "" })}
                aria-current={active ? "true" : undefined}
                className={`group relative overflow-hidden rounded-2xl border bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-md dark:bg-slate-900 ${active ? "border-slate-900 ring-1 ring-slate-900 dark:border-slate-200 dark:ring-slate-200" : "border-slate-200 dark:border-slate-800"}`}
              >
                <span className="absolute inset-x-0 top-0 h-1.5" style={{ background: tag?.color ?? "#94a3b8" }} />
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{area.name}</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{area.note}</p>
                  </div>
                  {tag && <TagBadge tag={tag} />}
                </div>
                <div className="mt-4 flex items-end justify-between gap-3">
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-5xl font-bold tabular-nums tracking-tight">{ipu ?? "—"}</span>
                      {delta !== null && delta !== 0 && (
                        <span className={`text-sm font-medium tabular-nums ${delta > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                          {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      IPU{station?.pollutant ? ` · dominant ${station.pollutant}` : ""}
                    </p>
                  </div>
                  <Sparkline data={ser.slice(-24)} />
                </div>
                <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  DOE station <b className="font-medium text-slate-700 dark:text-slate-300">{area.stationId}</b>
                  {station?.place ? ` · ${station.place}` : ""}
                </p>
              </a>
            );
          })}
        </section>

        {/* ─── Advice for selected area ─── */}
        {sel.ipu !== null && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
            <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: tagOf(sel.ipu).color }} />
            <p>
              <b>{sel.area.name}: {tagOf(sel.ipu).en} ({tagOf(sel.ipu).ms}).</b>{" "}
              <span className="text-slate-600 dark:text-slate-400">{tagOf(sel.ipu).advice}</span>
            </p>
          </div>
        )}

        {/* ─── Trend ─── */}
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-semibold">{daily ? "Daily peak IPU" : "Hourly IPU"} · {sel.area.name}</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                DOE station {sel.area.stationId} · {range.archive ? "from archive · " : ""}hover a bar for details
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Segmented items={AREAS.map((a) => ({ label: a.name, href: href({ area: a.key, tag: "" }), active: a.key === s.area }))} />
              <Segmented items={ranges.map((r) => ({ label: r.label, href: href({ range: r.key }), active: r.key === s.range }))} />
            </div>
          </div>

          {archiveError && (
            <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              Archive unavailable ({archiveError}). Showing DOE data only. Check the Supabase table and view (see app/page.tsx header).
            </div>
          )}

          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Now" value={sel.ipu} sub={sel.time ? fmtTime(sel.time) : undefined} />
            <Stat label={`Peak (${range.label})`} value={peak?.ipu ?? null} sub={peak ? fmtWhen(peak.time, daily) : undefined} />
            <Stat label="Average" value={avg} sub={daily ? `${series.length} days · ${totalWeight} hourly readings` : `${series.length} hourly readings`} />
            <Stat label="Lowest" value={low ? (low.min ?? low.ipu) : null} sub={low ? fmtWhen(low.time, daily) : undefined} />
          </dl>

          <div className="mt-6 overflow-x-auto">
            <BarChart data={series} slots={slots} step={step} end={end} range={range} />
          </div>
        </section>

        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          {/* ─── Tag distribution ─── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 lg:col-span-2 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-base font-semibold">{daily ? "Days by peak IPU tag" : "Hours by IPU tag"}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{sel.area.name}, last {range.label}</p>
            <div className="mt-4 flex h-4 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              {counts.filter((c) => c.n > 0).map((c) => (
                <div key={c.tag.key} title={`${c.tag.en}: ${c.n} ${unit}`} style={{ width: `${(c.n / Math.max(series.length, 1)) * 100}%`, background: c.tag.color }} />
              ))}
            </div>
            <ul className="mt-5 space-y-1">
              {counts.map(({ tag, n }) => (
                <li key={tag.key}>
                  <a
                    href={href({ tag: s.tag === tag.key ? "" : tag.key })}
                    className={`flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-slate-50 dark:hover:bg-slate-800/60 ${s.tag === tag.key ? "bg-slate-100 dark:bg-slate-800" : ""}`}
                  >
                    <span className="size-3 shrink-0 rounded" style={{ background: tag.color }} />
                    <span className="flex-1">
                      <span className="font-medium">{tag.en}</span>{" "}
                      <span className="text-slate-500 dark:text-slate-400">· {tag.ms}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        IPU {tag.min}{tag.max === Infinity ? "+" : `–${tag.max}`}
                      </span>
                    </span>
                    <span className="tabular-nums font-semibold">{n} {unit}</span>
                    <span className="w-10 text-right text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {series.length ? Math.round((n / series.length) * 100) : 0}%
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>

          {/* ─── Log with tags ─── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 lg:col-span-3 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">{daily ? "Daily log" : "Hourly log"}</h2>
              <div className="flex flex-wrap gap-1.5">
                <Chip href={href({ tag: "" })} active={!s.tag}>All</Chip>
                {TAGS.map((t) => (
                  <Chip key={t.key} href={href({ tag: t.key })} active={s.tag === t.key} color={t.color}>{t.en}</Chip>
                ))}
              </div>
            </div>
            <div className="mt-4 max-h-[28rem] overflow-auto rounded-lg border border-slate-100 dark:border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {daily ? (
                    <tr>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 text-right font-medium">Peak</th>
                      <th className="px-3 py-2 text-right font-medium">Avg</th>
                      <th className="px-3 py-2 text-right font-medium">Min</th>
                      <th className="px-3 py-2 font-medium">Tag (peak)</th>
                    </tr>
                  ) : (
                    <tr>
                      <th className="px-3 py-2 font-medium">Time (MYT)</th>
                      <th className="px-3 py-2 text-right font-medium">IPU</th>
                      <th className="px-3 py-2 text-right font-medium">Δ 1h</th>
                      <th className="px-3 py-2 font-medium">Tag</th>
                    </tr>
                  )}
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {tableRows.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">No readings for this filter.</td></tr>
                  )}
                  {tableRows.map((r) => {
                    if (daily) {
                      return (
                        <tr key={+r.time} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                            {fmtDate(r.time)}
                            {r.hours !== undefined && r.hours < 24 && <span className="ml-1.5 text-xs text-slate-400">({r.hours} h)</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.ipu}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.avg ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.min ?? "—"}</td>
                          <td className="px-3 py-2"><TagBadge tag={tagOf(r.ipu)} /></td>
                        </tr>
                      );
                    }
                    const prev = series[series.indexOf(r) - 1];
                    const d = prev && +r.time - +prev.time === HOUR ? r.ipu - prev.ipu : null;
                    return (
                      <tr key={+r.time} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtDayTime(r.time)}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.ipu}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                          {d === null ? "—" : d > 0 ? `+${d}` : d}
                        </td>
                        <td className="px-3 py-2"><TagBadge tag={tagOf(r.ipu)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* ─── Footer ─── */}
        <footer className="mt-10 space-y-2 border-t border-slate-200 pt-6 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <p>
            Source: Jabatan Alam Sekitar Malaysia (DOE), APIMS at eqms.doe.gov.my. Alor Setar = station CA03K, Kangar = station CA01R.
            Values are DOE&apos;s published hourly IPU, already calculated with DOE&apos;s rolling averages and dominant pollutant.
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5">
            <span>DOE keeps about 7 days.</span>
            {status === null && <span>Connect Supabase for a long-term archive (see the header comment in app/page.tsx).</span>}
            {status && "error" in status && (
              <span className="text-amber-700 dark:text-amber-300">Archive error: {status.error}</span>
            )}
            {status && "total" in status && (
              <span>
                <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500 align-middle" />
                Archive: {status.total.toLocaleString("en-MY")} hourly readings
                {status.since ? ` since ${fmtDate(status.since)}` : " (filling on first load)"}.
              </span>
            )}
            <span>The page refreshes itself every 10 minutes.</span>
          </p>
        </footer>
      </div>
    </main>
  );
}

/* ═══════════════════════════════ COMPONENTS ═══════════════════════════════ */

function TagBadge({ tag }: { tag: Tag }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tag.badge}`}>
      <span className="size-1.5 rounded-full" style={{ background: tag.color }} />
      {tag.en}
      <span className="opacity-70">· {tag.ms}</span>
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  const tag = value !== null ? tagOf(value) : null;
  return (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-1 flex items-center gap-2">
        <span className="text-2xl font-bold tabular-nums">{value ?? "—"}</span>
        {tag && <span className="size-2 rounded-full" style={{ background: tag.color }} title={tag.en} />}
      </dd>
      {sub && <dd className="text-xs text-slate-500 dark:text-slate-400">{sub}</dd>}
    </div>
  );
}

function Segmented({ items }: { items: { label: string; href: string; active: boolean }[] }) {
  return (
    <nav className="inline-flex flex-wrap rounded-lg bg-slate-100 p-0.5 text-sm dark:bg-slate-800">
      {items.map((it) => (
        <a
          key={it.label}
          href={it.href}
          aria-current={it.active ? "true" : undefined}
          className={`rounded-md px-3 py-1.5 font-medium transition ${it.active ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100" : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"}`}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

function Chip({ href, active, color, children }: { href: string; active: boolean; color?: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${active ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-200 text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300"}`}
    >
      {color && <span className="size-2 rounded-full" style={{ background: color }} />}
      {children}
    </a>
  );
}

function Sparkline({ data }: { data: Reading[] }) {
  if (data.length < 2) return null;
  const w = 120, h = 36, max = Math.max(100, ...data.map((d) => d.ipu));
  const bw = w / 24;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label="Last 24 hours" className="shrink-0">
      {data.map((d, i) => {
        const bh = Math.max(2, (d.ipu / max) * h);
        return <rect key={+d.time} x={i * bw + (24 - data.length) * bw} y={h - bh} width={bw - 1.5} height={bh} rx={1} fill={tagOf(d.ipu).color} />;
      })}
    </svg>
  );
}

/** One bar per slot (hour or day), ending at the slot that starts at `end`. */
function BarChart({ data, slots, step, end, range }: { data: Reading[]; slots: number; step: number; end: number; range: Range }) {
  const W = 960, H = 280, m = { t: 12, r: 12, b: 28, l: 36 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  if (data.length === 0) {
    return <p className="py-16 text-center text-sm text-slate-500">No readings available for this range yet.</p>;
  }
  const start = end - (slots - 1) * step;
  const peak = Math.max(...data.map((d) => d.ipu));
  const yMax = peak <= 100 ? 120 : Math.ceil((peak * 1.1) / 50) * 50;
  const y = (v: number) => m.t + ph - (v / yMax) * ph;
  const slot = pw / slots;
  const gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
  const bw = Math.max(slot - gap, 0.8);
  const x = (t: Date) => m.l + ((+t - start) / step) * slot;
  const grid = [0, 50, 100, 200, 300, 400, 500].filter((v) => v <= yMax);
  const ticks = Array.from({ length: slots }, (_, i) => new Date(start + i * step))
    .map((t) => ({ t, label: tickLabel(range, t) }))
    .filter((k): k is { t: Date; label: string } => k.label !== null);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px] text-slate-500 dark:text-slate-400" role="img" aria-label={`${range.daily ? "Daily peak" : "Hourly"} IPU bar chart`}>
      {grid.map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v === 0 ? 0.5 : 0.15} strokeDasharray={v === 0 ? undefined : "3 4"} />
          <text x={m.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="currentColor" className="tabular-nums">{v}</text>
        </g>
      ))}
      {ticks.map(({ t, label }) => (
        <text key={+t} x={x(t) + slot / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="currentColor">{label}</text>
      ))}
      {data.filter((d) => +d.time >= start).map((d) => {
        const tag = tagOf(d.ipu);
        const bx = x(d.time) + gap / 2, top = y(d.ipu), base = y(0);
        const r = Math.min(3, bw / 2, base - top);
        const path = `M${bx},${base}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${base}Z`;
        const tip = range.daily
          ? `${fmtDate(d.time)} · peak ${d.ipu} · avg ${d.avg ?? "—"} · min ${d.min ?? "—"} · ${d.hours ?? "?"} h · ${tag.en} (${tag.ms})`
          : `${fmtDayTime(d.time)} · IPU ${d.ipu} · ${tag.en} (${tag.ms})`;
        return (
          <g key={+d.time} className="group">
            <title>{tip}</title>
            <rect x={x(d.time)} y={m.t} width={slot} height={ph} fill="currentColor" fillOpacity={0.07} className="opacity-0 group-hover:opacity-100" />
            <path d={path} fill={tag.color} className="transition-opacity group-hover:opacity-75" />
          </g>
        );
      })}
    </svg>
  );
}
