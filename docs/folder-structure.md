# Folder structure

Next.js **App Router**: routes and route handlers live under `src/app/`. **Backend logic** is not a separate repo—use `src/server/` for code that must never ship to the browser (agents, DB jobs, provider clients).

```
adloom/
├── docs/
│   └── folder-structure.md    # this file
├── prisma/
│   └── schema.prisma          # Job, Asset
├── public/                    # static assets (add as needed)
├── src/
│   ├── app/
│   │   ├── api/               # HTTP API (Route Handlers = "backend" endpoints)
│   │   │   ├── health/
│   │   │   └── jobs/
│   │   ├── brief/             # example UI route
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   ├── features/          # screens / flows (brief, job detail, preview)
│   │   └── ui/                # shared primitives (Button, Field) — add as needed
│   ├── lib/                   # shared: env, db client, small utils
│   ├── server/
│   │   ├── agents/            # one file per reasoning step (Gemini-backed)
│   │   ├── pipeline/          # compose agents in order
│   │   ├── services/          # external APIs: Gemini, images, video, TTS, music, assembly
│   │   └── jobs/              # Prisma helpers for Job lifecycle
│   └── types/                 # shared TS types (creative JSON, API DTOs)
└── package.json
```

## Where new “agents” go

| Concern | Location |
|--------|-----------|
| Brief normalization | `src/server/agents/brief-normalizer.ts` |
| Strategy / localization angle | `src/server/agents/creative-strategy.ts` |
| Headlines / captions / CTA | `src/server/agents/copy-writer.ts` |
| Image & video prompt strings | `src/server/agents/media-prompts.ts` |
| Safety / policy pass | `src/server/agents/safety.ts` |
| Order of execution + error handling | `src/server/pipeline/runCreativePipeline.ts` |

Add new files under `agents/` and **import them from the pipeline** (or from a future orchestrator) so API routes stay thin.

## Where provider integrations go

`src/server/services/` — thin wrappers (Gemini SDK, Nano Banana, Veo, TTS, Lyria, FFmpeg). Agents call services through these modules, not from React components.

## Frontend

- **Pages** → `src/app/<route>/page.tsx`
- **Feature UI** → `src/components/features/<feature>/`
- **Reusable UI** → `src/components/ui/`

## Optional later

- `src/worker/` or `workers/` — background jobs (long video, polling Veo) if you outgrow serverless timeouts
- `src/app/api/webhooks/` — provider callbacks
