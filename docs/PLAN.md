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
| Database | PostgreSQL via Prisma ORM (Docker Compose) |
| AI orchestration | Gemini 2.0 Flash (`@google/generative-ai`) |
| Image generation | Nano Banana / Gemini 2.5 Flash Image (`@google/genai`) |
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
│   └── schema.prisma                       # Session, Message, Asset, Snapshot
├── public/
│   └── uploads/                            # Generated images + product uploads (local dev)
├── src/
│   ├── app/                                # Next.js App Router
│   │   ├── page.tsx                        # Home / landing
│   │   ├── layout.tsx                      # Root layout
│   │   ├── globals.css                     # Tailwind + theme
│   │   ├── chat/[id]/page.tsx              # Chat + storyboard UI (Loop 1 & 2)
│   │   ├── export/[id]/page.tsx            # Final video export page — TODO
│   │   └── api/
│   │       ├── health/route.ts             # Health check
│   │       └── sessions/
│   │           ├── route.ts                # POST: create session
│   │           └── [id]/
│   │               ├── route.ts            # GET: fetch session
│   │               ├── chat/route.ts       # POST: streaming chat (SSE) — handles both script & keyframe phases
│   │               ├── approve/route.ts    # POST: extract brief, lock script
│   │               ├── upload/route.ts     # POST: product image upload
│   │               ├── snapshots/route.ts  # GET: list snapshots
│   │               ├── generate/route.ts   # POST: kick off video pipeline — TODO
│   │               └── export/route.ts     # GET: download final videos — TODO
│   ├── components/
│   │   ├── chat/                           # Chat-specific components — TODO
│   │   └── ui/                             # Shared primitives (Button, etc.) — TODO
│   ├── lib/
│   │   ├── db.ts                           # Prisma singleton
│   │   └── env.ts                          # Zod-validated env vars
│   ├── server/
│   │   └── services/
│   │       ├── gemini.ts                   # Gemini: streaming chat, keyframe agent, brief extraction, localization
│   │       ├── session.ts                  # Session/Message/Asset/Snapshot CRUD (Prisma)
│   │       ├── nano-banana.ts              # Image generation via Gemini 2.5 Flash Image
│   │       ├── veo.ts                      # Video generation — TODO
│   │       ├── tts.ts                      # Text-to-speech — TODO
│   │       ├── lyria.ts                    # Music (optional) — TODO
│   │       └── assembly.ts                 # Video + VO + music compositing — TODO
│   └── types/
│       └── index.ts                        # Shared types: Region, Beat, Brief, etc.
├── docker-compose.yml                      # PostgreSQL service
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
| **Message** | Chat history. Role (`user` / `assistant` / `system`), content, optional `imageUrl` for product uploads. |
| **Snapshot** | Versioned beat list snapshots. Linked to session and optionally to the message that created it. User can select which version to approve. |
| **Asset** | Generated files. Kind (`product_image`, `character`, `keyframe`, `video`, `voiceover`, `music`, `preview`), region, shot index, version, URI, prompt used, JSON metadata. |

---

## Pipeline phases

### Phase A — Chat (Loop 1) → PRD: G1

| Step | Description | Status |
|------|-------------|--------|
| A1 | Home page with "Start new ad" → creates Session, redirects to chat | DONE |
| A2 | Chat UI with streaming messages (SSE from Gemini) | DONE |
| A3 | Gemini system prompt: guides user to define product, tone, audience, beats, spoken lines | DONE |
| A4 | Beat list snapshot versioning via `save_beat_list` tool call | DONE |
| A5 | "Approve script" button → Gemini extracts structured brief (beats + localized scripts for US/IN/CN) → saved to DB | DONE |
| A6 | Product image upload in chat flow | DONE |
| A7 | Region selection UI (checkboxes: US / India / China) | TODO |

### Phase B — Keyframes (Loop 2) → PRD: G2, G5

| Step | Description | Status |
|------|-------------|--------|
| B1 | Gemini keyframe agent with `generate_character` and `generate_keyframe` tool calls | DONE |
| B2 | Nano Banana image generation service (`@google/genai`, `gemini-2.5-flash-image`) | DONE |
| B3 | Chat route handles keyframe phase — tool calls trigger Nano Banana, results streamed via SSE | DONE |
| B4 | Tabbed storyboard panel (Script / Characters / Keyframes) with image preview lightbox | DONE |
| B5 | Character reference images used as Nano Banana inputs for keyframe consistency | DONE |
| B6 | Currently English-only; extend to all locales when pipeline is solid | TODO |
| B7 | "Approve keyframes" gate — nothing proceeds to video until user confirms | TODO |

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
| GET | `/api/sessions/[id]` | Fetch session + messages + assets + snapshots | DONE |
| POST | `/api/sessions/[id]/chat` | SSE streaming chat — script phase (chatting) and keyframe phase (script_approved / keyframes_review) | DONE |
| POST | `/api/sessions/[id]/approve` | Extract brief, localize, lock script | DONE |
| POST | `/api/sessions/[id]/upload` | Upload product image | DONE |
| GET | `/api/sessions/[id]/snapshots` | List snapshots | DONE |
| POST | `/api/sessions/[id]/snapshots/[snapshotId]/select` | Select a snapshot version | DONE |
| POST | `/api/sessions/[id]/generate` | Kick off video pipeline (Veo + TTS + assembly) | TODO |
| GET | `/api/sessions/[id]/export` | Download final videos | TODO |
| GET | `/api/health` | Health check | DONE |

---

## Pages summary

| Route | Purpose | Status |
|-------|---------|--------|
| `/` | Landing page | DONE |
| `/chat/[id]` | Chat + tabbed storyboard (script, characters, keyframes) | DONE |
| `/export/[id]` | Side-by-side video preview + download | TODO |

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | PostgreSQL: `postgresql://adloom:adloom@localhost:5432/adloom?schema=public` |
| `GEMINI_API_KEY` | Yes | Gemini for chat, brief extraction, prompt generation, and Nano Banana image generation |
| `OPENROUTER_API_KEY` | Optional | Alternative to GEMINI_API_KEY — routes through OpenRouter |
| Veo credentials | For Phase C | Video generation |
| TTS credentials | For Phase C | Voice synthesis |

---

## Running locally

```bash
npm install

# Start PostgreSQL
docker-compose up -d

# Configure environment
cp .env.example .env          # fill in GEMINI_API_KEY

# Set up database
npx prisma generate
npx prisma db push

# Start dev server
npm run dev                    # http://localhost:3000
npm run db:studio              # http://localhost:5555 (DB browser)
```

---

## Demo checklist (PRD section 7)

- [ ] End-to-end: chat → image upload → select 3 regions → 3 downloadable videos
- [ ] Obvious language difference (EN / HI / ZH) between clips
- [ ] Obvious visual locale difference between clips
- [ ] Product visibly consistent with upload in at least one hero shot per variant
