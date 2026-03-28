# Implementation Plan — Adloom

> Maps PRD goals (G1–G5) to concrete tasks, files, and status.
> Updated: 2026-03-28

---

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 15 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Database | SQLite via Prisma ORM |
| AI orchestration | Gemini 2.0 Flash (`@google/generative-ai`) |
| Image generation | Nano Banana (Google GenMedia) |
| Video generation | Veo (Google GenMedia) |
| Voice | TTS (Google / TBD) + lip sync |
| Music (optional) | Lyria |
| Assembly | FFmpeg or hosted compositor |

---

## Folder structure

```
adloom/
├── docs/
│   ├── PRD.md                              # Product requirements
│   ├── PLAN.md                             # This file
│   └── high-level-overview.png             # Architecture diagram
├── prisma/
│   └── schema.prisma                       # Session, Message, Asset
├── public/
│   └── uploads/                            # Product images (local dev)
├── src/
│   ├── app/                                # Next.js App Router
│   │   ├── page.tsx                        # Home / landing
│   │   ├── layout.tsx                      # Root layout
│   │   ├── globals.css                     # Tailwind + theme
│   │   ├── chat/[id]/page.tsx              # Chat UI (Loop 1)
│   │   ├── review/[id]/page.tsx            # Keyframe review UI (Loop 2) — TODO
│   │   ├── export/[id]/page.tsx            # Final video export page — TODO
│   │   └── api/
│   │       ├── health/route.ts             # Health check
│   │       └── sessions/
│   │           ├── route.ts                # POST: create session
│   │           └── [id]/
│   │               ├── route.ts            # GET: fetch session
│   │               ├── chat/route.ts       # POST: streaming chat (SSE)
│   │               ├── approve/route.ts    # POST: extract brief, lock script
│   │               ├── upload/route.ts     # POST: product image upload — TODO
│   │               ├── keyframes/route.ts  # POST: generate / GET: list — TODO
│   │               ├── generate/route.ts   # POST: kick off video pipeline — TODO
│   │               └── export/route.ts     # GET: download final videos — TODO
│   ├── components/
│   │   ├── chat/                           # Chat-specific components — TODO
│   │   ├── review/                         # Keyframe review components — TODO
│   │   └── ui/                             # Shared primitives (Button, etc.) — TODO
│   ├── lib/
│   │   ├── db.ts                           # Prisma singleton
│   │   └── env.ts                          # Zod-validated env vars
│   ├── server/
│   │   └── services/
│   │       ├── gemini.ts                   # Gemini: streaming chat + brief extraction
│   │       ├── session.ts                  # Session/Message CRUD (Prisma)
│   │       ├── nano-banana.ts              # Image generation — TODO
│   │       ├── veo.ts                      # Video generation — TODO
│   │       ├── tts.ts                      # Text-to-speech — TODO
│   │       ├── lyria.ts                    # Music (optional) — TODO
│   │       └── assembly.ts                 # Video + VO + music compositing — TODO
│   └── types/
│       └── index.ts                        # Shared types: Region, Beat, Brief, etc.
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── next.config.ts
```

---

## Data model (Prisma)

| Model | Purpose |
|-------|---------|
| **Session** | One ad project. Tracks status (`chatting` → `script_approved` → `keyframes_review` → `keyframes_approved` → `generating` → `done`), extracted brief JSON, beat list JSON, selected regions. |
| **Message** | Chat history. Role (`user` / `assistant`), content, optional `imageUrl` for product uploads. |
| **Asset** | Generated files. Kind (`product_image`, `keyframe`, `video`, `voiceover`, `music`, `preview`), region, shot index, version, URI, prompt used. |

---

## Pipeline phases

### Phase A — Chat (Loop 1) → PRD: G1

| Step | Description | Status |
|------|-------------|--------|
| A1 | Home page with "Start new ad" → creates Session, redirects to chat | DONE |
| A2 | Chat UI with streaming messages (SSE from Gemini) | DONE |
| A3 | Gemini system prompt: guides user to define product, tone, audience, beats, spoken lines | DONE |
| A4 | "Approve script" button → Gemini extracts structured brief (beats + localized scripts for US/IN/CN) → saved to DB | DONE |
| A5 | Product image upload in chat flow | TODO |
| A6 | Region selection UI (checkboxes: US / India / China) | TODO |
| A7 | Brief summary panel after approval (show beats, scripts, selected regions) | TODO |

### Phase B — Keyframes (Loop 2) → PRD: G2, G5

| Step | Description | Status |
|------|-------------|--------|
| B1 | Gemini generates per-beat, per-region image prompts (product ref + locale art direction) | TODO |
| B2 | Nano Banana generates keyframes (4–8 per region) | TODO |
| B3 | Keyframe review page: grid of frames, per-frame feedback, selective regeneration | TODO |
| B4 | "Approve keyframes" gate — nothing proceeds to video until user confirms | TODO |

### Phase C — Video generation → PRD: G3, G4, G5

| Step | Description | Status |
|------|-------------|--------|
| C1 | Veo: image-to-video from approved keyframes (prefer i2v; fallback t2v) | TODO |
| C2 | TTS: generate voiceover per region from localized scripts | TODO |
| C3 | Lip sync: apply VO to generated video faces (API TBD) | TODO |
| C4 | Lyria (optional): background music matching mood/pace | TODO |
| C5 | Assembly: combine video + VO + music + text overlays → final MP4 per region | TODO |

### Phase D — Export → PRD: G3

| Step | Description | Status |
|------|-------------|--------|
| D1 | Export page: 3 video previews side-by-side (US / IN / CN) | TODO |
| D2 | Download buttons per region (labeled MP4 files) | TODO |
| D3 | Session history page (list past sessions from DB) | TODO |

---

## API routes summary

| Method | Route | Purpose | Status |
|--------|-------|---------|--------|
| POST | `/api/sessions` | Create session | DONE |
| GET | `/api/sessions/[id]` | Fetch session + messages + assets | DONE |
| POST | `/api/sessions/[id]/chat` | SSE streaming chat with Gemini | DONE |
| POST | `/api/sessions/[id]/approve` | Extract brief, lock script | DONE |
| POST | `/api/sessions/[id]/upload` | Upload product image | TODO |
| POST | `/api/sessions/[id]/keyframes` | Generate keyframes (Nano Banana) | TODO |
| GET | `/api/sessions/[id]/keyframes` | List keyframes for review | TODO |
| POST | `/api/sessions/[id]/generate` | Kick off video pipeline (Veo + TTS + assembly) | TODO |
| GET | `/api/sessions/[id]/export` | Download final videos | TODO |
| GET | `/api/health` | Health check | DONE |

---

## Pages summary

| Route | Purpose | Status |
|-------|---------|--------|
| `/` | Landing page | DONE |
| `/chat/[id]` | Chat + brief collection | DONE |
| `/review/[id]` | Keyframe review + approval | TODO |
| `/export/[id]` | Side-by-side video preview + download | TODO |

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | SQLite: `file:./dev.db` |
| `GEMINI_API_KEY` | Yes | Gemini for chat, brief extraction, prompt generation |
| Nano Banana credentials | For Phase B | Image generation |
| Veo credentials | For Phase C | Video generation |
| TTS credentials | For Phase C | Voice synthesis |

---

## Who works on what (suggested split)

| Area | Scope |
|------|-------|
| **Frontend** | Chat polish, image upload UI, keyframe review page, export page, region selector |
| **Gemini agents** | Prompt engineering for brief extraction, keyframe prompt generation, localization quality |
| **Media pipeline** | Nano Banana, Veo, TTS, lip sync API integration, assembly |
| **Infra / polish** | Real-time progress (SSE/WebSocket for generation status), error handling, demo prep |

---

## Running locally

```bash
npm install
cp .env.example .env          # fill in GEMINI_API_KEY
npx prisma generate
npx prisma db push
npm run dev                    # http://localhost:3000
npm run db:studio              # http://localhost:5555 (DB browser)
```

---

## Demo checklist (PRD section 7)

- [ ] End-to-end: chat → image upload → select 3 regions → 3 downloadable videos
- [ ] Obvious language difference (EN / HI / ZH) between clips
- [ ] Obvious visual locale difference between clips
- [ ] Product visibly consistent with upload in at least one hero shot per variant
