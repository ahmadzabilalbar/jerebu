# Jerebu Watch

Hourly Air Pollutant Index (IPU / Indeks Pencemaran Udara) dashboard for **Alor Setar** (DOE station CA03K) and **Kangar** (CA01R), built with Next.js, Tailwind CSS and optional Supabase.

- Official data from Jabatan Alam Sekitar (DOE) APIMS, fetched server-side
- Readings tagged on the DOE IPU scale: Baik, Sederhana, Tidak Sihat, Sangat Tidak Sihat, Berbahaya
- 24 h, 3-day and 7-day views straight from DOE; 30-day, 90-day and 1-year views with the Supabase archive
- No authentication

All application code is in [`app/page.tsx`](app/page.tsx). Its header comment has the data sources and the Supabase SQL.

## Run locally

```bash
npm install
npm run dev   # http://localhost:3000
```

## Long-term archive (optional)

DOE keeps only about 7 days of history. To keep more:

1. Create a Supabase project and run the SQL from the header of `app/page.tsx` in the SQL editor.
2. Copy `.env.example` to `.env.local` and fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Add the same two variables in Vercel under Project → Settings → Environment Variables.

Each page load saves the last 7 days, and the daily cron in `vercel.json` makes sure it runs at least once a day.

## Deploy

Import this repo at [vercel.com/new](https://vercel.com/new). No settings are needed.
