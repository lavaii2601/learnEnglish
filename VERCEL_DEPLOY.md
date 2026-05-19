Vercel deploy checklist

1. Build & Output
- Build Command: `npm run build`
- Output Directory: `dist`
- Rewrites: `/api/(.*)` -> `/api/[...route].js` (already in `vercel.json`)

2. Environment Variables (Project Settings)
- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (recommended for backend writes)
- Optional: `SUPABASE_ANON_KEY` (if not using service role key)
- Optional: `ENABLE_SAMPLE_SEED=true` to seed sample data on first start

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
- Check `vercel` build logs for missing env variables.
