# Adloom

Locale-adaptive video ad generator. One concept, three markets (US / India / China), full video exports with localized visuals, speech, and lip sync.

## Quick start

```bash
npm install
cp .env.example .env          
npx prisma generate
npx prisma db push
npm run dev                    # http://localhost:3000
```

Browse the database: `npm run db:studio` → http://localhost:5555

## Docs

- **[PRD](docs/PRD.md)** — Product requirements and success criteria
- **[PLAN](docs/PLAN.md)** — Implementation plan, task status, folder structure, API routes, who-works-on-what

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind v4 · Prisma + SQLite · Gemini 2.0 Flash · Nano Banana · Veo · TTS · Lyria (optional)

## What's working

- Landing page → create session → chat with Gemini (streaming)
- "Approve script" → Gemini extracts structured brief + localized scripts (US/IN/CN)
- Session + message persistence in SQLite

## What's next

See [PLAN.md](docs/PLAN.md) for the full task list — image upload, keyframe generation/review, video pipeline, export page.
