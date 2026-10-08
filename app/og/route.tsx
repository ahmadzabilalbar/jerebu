/**
 * Link-preview image (1200×630) showing the current IPU for each location.
 * Referenced from generateMetadata() in app/page.tsx. It always reads DOE itself;
 * the ?h= query param is only a cache-buster, so the image can't be spoofed via the URL.
 * STATIONS and SCALE mirror AREAS and TAGS in app/page.tsx.
 */
import { ImageResponse } from "next/og";

export const revalidate = 300;

const STATIONS = [
  { id: "CA03K", name: "Alor Setar", state: "Kedah" },
  { id: "CA01R", name: "Kangar", state: "Perlis" },
];

const SCALE = [
  { max: 50, en: "Good", ms: "Baik", color: "#2563eb", ink: "#ffffff" },
  { max: 100, en: "Moderate", ms: "Sederhana", color: "#16a34a", ink: "#ffffff" },
  { max: 200, en: "Unhealthy", ms: "Tidak Sihat", color: "#eab308", ink: "#1c1917" },
  { max: 300, en: "Very Unhealthy", ms: "Sangat Tidak Sihat", color: "#ea580c", ink: "#ffffff" },
  { max: Infinity, en: "Hazardous", ms: "Berbahaya", color: "#dc2626", ink: "#ffffff" },
];

export async function GET() {
  const where = encodeURIComponent(`STATION_ID IN (${STATIONS.map((s) => `'${s.id}'`).join(",")})`);
  let rows: Record<string, number | string | null>[] = [];
  try {
    const res = await fetch(
      `https://eqms.doe.gov.my/api3/publicmapproxy/PUBLIC_DISPLAY/CAQM_MCAQM_Current_Reading/MapServer/0/query?where=${where}&outFields=STATION_ID,API,DATETIME&returnGeometry=false&f=json`,
      { headers: { "User-Agent": "Mozilla/5.0 (JerebuWatch dashboard)" }, next: { revalidate: 300 }, signal: AbortSignal.timeout(10_000) },
    );
    rows = ((await res.json()) as { features?: { attributes: Record<string, number | string | null> }[] }).features?.map((f) => f.attributes) ?? [];
  } catch {
    // Render the card with dashes rather than failing the preview.
  }

  const cards = STATIONS.map((s) => {
    const row = rows.find((r) => r.STATION_ID === s.id);
    const ipu = typeof row?.API === "number" && row.API >= 0 ? Math.round(row.API) : null;
    return { ...s, ipu, tag: ipu === null ? null : SCALE.find((t) => ipu <= t.max)! };
  });
  const epoch = rows.map((r) => r.DATETIME).find((d): d is number => typeof d === "number");
  // DOE stores MYT wall-clock time as if it were UTC, so format it as UTC.
  const when = epoch
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(epoch))
    : null;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0f172a", color: "#f8fafc", padding: "48px 56px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 30, color: "#94a3b8" }}>
          <div style={{ display: "flex", fontWeight: 700, letterSpacing: 2 }}>JEREBU WATCH · IPU</div>
          <div style={{ display: "flex" }}>{when ? `${when} MYT` : "DOE APIMS"}</div>
        </div>
        <div style={{ display: "flex", flex: 1, gap: 32, marginTop: 36 }}>
          {cards.map((c) => (
            <div key={c.id} style={{ display: "flex", flexDirection: "column", flex: 1, borderRadius: 32, background: c.tag?.color ?? "#334155", color: c.tag?.ink ?? "#f8fafc", padding: "32px 40px" }}>
              <div style={{ display: "flex", fontSize: 44, fontWeight: 700 }}>{c.name}</div>
              <div style={{ display: "flex", fontSize: 26, opacity: 0.85 }}>{c.state} · {c.id}</div>
              <div style={{ display: "flex", fontSize: 190, fontWeight: 800, lineHeight: 1, marginTop: 18 }}>{c.ipu ?? "—"}</div>
              <div style={{ display: "flex", fontSize: 38, fontWeight: 700, marginTop: "auto" }}>{c.tag ? c.tag.ms : "Tiada data"}</div>
              <div style={{ display: "flex", fontSize: 26, opacity: 0.85 }}>{c.tag ? c.tag.en : "No data"}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 24, color: "#94a3b8" }}>Official data: Jabatan Alam Sekitar (DOE) APIMS · updated hourly</div>
      </div>
    ),
    { width: 1200, height: 630, headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } },
  );
}
