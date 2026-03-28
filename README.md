# Adloom

Locale-adaptive video ad generator. One concept, three markets (US / India / China), full video exports with localized visuals, speech, and lip sync.

## Quick start

```bash
npm install
cp .env.example .env          
npx prisma generate
npx prisma db push
docker compose up -d           # Postgres + MinIO + Inngest dev server (see below)
npm run dev                    # on the host — note the port in the terminal (default 3000)
```

**Inngest** runs in Docker. It polls **`http://host.docker.internal:${NEXT_DEV_PORT}/api/inngest`** (from [`.env`](.env): `NEXT_DEV_PORT`, default **3000**). If Next says *“Port 3000 is in use … using 3004”*, set `NEXT_DEV_PORT=3004` in `.env` and run **`docker compose up -d inngest`** again (or free port 3000 and keep `3000`). UI: **http://localhost:8288**.

**Turbopack:** use **`npm run dev:turbo`** if you want it; the default **`npm run dev`** avoids Turbopack, which can hit missing `.next/.../app-build-manifest.json` errors on some setups.

If Inngest is stopped or unreachable, `inngest.send` can **fetch failed**; with `npm run dev` the app **falls back to in-process** image generation (see server logs). Set `INNGEST_DISABLE_INLINE_FALLBACK=1` to disable that. Optional CLI instead of Docker: `npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest`.

For production, configure `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` from the Inngest dashboard and point your app URL at `/api/inngest`.

Browse the database: `npm run db:studio` → http://localhost:5555

## Docs

- **[PRD](docs/PRD.md)** — Product requirements and success criteria
- **[PLAN](docs/PLAN.md)** — Implementation plan, task status, folder structure, API routes, who-works-on-what

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind v4 · Prisma + PostgreSQL · Inngest (image jobs) · Gemini 2.0 Flash · Nano Banana · Veo · TTS · Lyria (optional)

## What's working

- Landing page → create session → chat with Gemini (streaming)
- "Approve script" → Gemini extracts structured brief + localized scripts (US/IN/CN)
- Session + message persistence in PostgreSQL; assets in MinIO; image generation jobs via Inngest

## What's next

See [PLAN.md](docs/PLAN.md) for the full task list — image upload, keyframe generation/review, video pipeline, export page.
