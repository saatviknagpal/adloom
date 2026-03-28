# Adloom

Locale-adaptive video ad generator. One concept, three markets (US / India / China), full video exports with localized visuals, speech, and lip sync.

## Quick start

```bash
npm install
cp .env.example .env          
npx prisma generate
npx prisma db push
docker compose up -d           # Postgres + MinIO (see .env for ports)
npm run dev                    # http://localhost:3000
```

In a **second terminal**, run the Inngest Dev Server so **character/keyframe image jobs** execute locally:

```bash
npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest
```

Without this process, `inngest.send` from the app will not deliver jobs and image generation will time out. For production, configure `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` from the Inngest dashboard and point your app URL at `/api/inngest`.

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
