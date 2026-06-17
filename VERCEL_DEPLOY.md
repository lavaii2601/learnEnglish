Vercel deploy checklist

1. Build & Output
- Build Command: `npm run build`
- Output Directory: `dist`
- Framework Preset: `Other` (already set in `vercel.json`)
- Node.js: `24.x` (already set in `package.json`)
- API routes are served automatically from `api/[...route].js`

2. Environment Variables (Project Settings)
- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (required for backend writes: add/edit/delete)
- Optional: `SUPABASE_ANON_KEY` (read-only fallback; not enough for reliable add/edit/delete)
- Optional: `ENABLE_SAMPLE_SEED=true` to seed sample data on first start
- Optional but recommended for custom domains: `ALLOWED_ORIGINS=https://your-domain.com`

3. Secrets handling
- Never commit `.env` with real keys.
- Use Vercel's Environment Variables for Production/Preview.

4. Local testing
- Create `.env` at project root (use `.env.example` as template) and fill values.
- Run locally:
```powershell
npm install
npm run start:api   # backend only
npm run dev         # frontend + backend
```

5. Troubleshooting
- If API returns 500 during init: ensure `SUPABASE_URL` and one of `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` are set.
- If add/edit/delete does not affect Supabase: set `SUPABASE_SERVICE_ROLE_KEY` in Vercel Project Settings for Production and redeploy.
- In production, `/api/health` only returns `{ "ok": true }` to avoid exposing server configuration.
- If browser requests are blocked by CORS on a custom domain, set `ALLOWED_ORIGINS` to that exact origin, for example `https://your-domain.com`.
- Check `vercel` build logs for missing env variables.
