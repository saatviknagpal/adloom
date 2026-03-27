# PRD: Locale-Adaptive Video Ads (Hackathon)

## 1. Executive summary

**Product:** A lightweight SaaS where an agency or DTC founder **chats with an agent** to lock **one ad concept and script**, uploads a **product image**, then generates **three market variants** (United States, India, China) as **full-composit videos**: same narrative and motion intent, with **region-appropriate character, environment, and spoken language**, including **lip sync**. Still **keyframes** are generated with **Nano Banana**; **Veo** assembles them into video.

**Hackathon scope:** No authentication, no content-safety product features — optimize for **demo clarity** and **three exports**.

---

## 2. Problem & goals

**Problem:** Global campaigns need **localized creative** (language, setting, casting feel) without rebuilding the whole concept from scratch each time.

**Goals:**

- **G1:** User collaborates with an agent to **finalize copy/script** through iteration.
- **G2:** User uploads **product imagery** so the ad can show **believable product-in-scene compositing** (e.g. character drinking from the uploaded can).
- **G3:** User selects **target regions** (default: **US, India, China**) and receives **N = 3** **exported videos** — one per selected region.
- **G4:** Each variant uses **regional language speech** with **lip sync** (English US, Hindi India, Mandarin China).
- **G5:** Each variant adjusts **character and background** for locale while preserving **the same script structure / story beats**.

**Non-goals (explicit):** Auth, billing, moderation/safety pipelines, arbitrary country list beyond the demo three, long-term asset libraries.

---

## 3. Users & context

| Persona | Needs |
|--------|--------|
| **DTC founder** | Fast, guided creative; one product; few variants. |
| **Agency user** | Repeatable pipeline from script → localized renders; clear exports for clients. |

---

## 4. User journey (happy path)

1. **Chat:** User describes brand, offer, tone, and refines **script / dialogue** with the agent until approved.
2. **Product image:** User uploads **one (or more) product images**; agent uses them as **reference for compositing** in scenes (e.g. drink, hold, place on table).
3. **Region selection:** User selects **which of {US, India, China}** to generate (default: all three).
4. **Generate:** System produces **per-region pipelines**: localized dialogue → **keyframes (Nano Banana)** with **product + locale-consistent character/environment** → **video (Veo)** with **lip sync** and **regional language audio**.
5. **Deliver:** User downloads **up to three MP4 files** (one per region), clearly labeled by market.

---

## 5. Functional requirements

### 5.1 Chat agent (copy / script)

- Multi-turn **chat UI** to draft and revise **ad copy and spoken script**.
- Agent outputs a **single canonical scene list** (beats) shared across locales: e.g. hook → problem → product reveal → CTA.
- **Localization:** For each selected region, produce **translated/adapted dialogue** (not three unrelated scripts) — **Hindi (India)**, **English (US)**, **Mandarin (China)**.

### 5.2 Product image in chat

- **Upload** product image(s) in the chat flow (formats TBD: e.g. PNG/JPEG).
- Images are **inputs** to keyframe generation so the **same product appearance** is composited into scenes (full compositing intent: product interacts with character/environment).

### 5.3 Region & language

- User-facing targeting: **region + language** only (no extra demographic fields for v1).
- **Mapping (v1):**

  | Region | Language (spoken) |
  |--------|-------------------|
  | United States | English |
  | India | Hindi |
  | China | Mandarin |

### 5.4 Video generation

- **Keyframes:** Generated with **Nano Banana** per region, consistent **storyboard beats**, **locale-specific** character styling and **background**, **product** integrated into frames.
- **Video:** **Veo** stitches keyframes (and/or conditioned segments) into a coherent **MP4** per region.
- **Audio:** **Regional language** dialogue; **lip sync required** (implementation detail: model/API that supports lip sync with generated faces — called out in technical notes).
- **Outputs:** **N exports** = number of regions selected (max **3** for demo).

### 5.5 Selection UI

- Checkboxes or multi-select for **US / India / China**; generation runs only for chosen regions.

---

## 6. Technical notes (for implementers)

- **Pipeline order (conceptual):** Approved master beats → **per-locale script** → **per-locale keyframes** (product ref + locale art direction) → **per-locale video** + **localized audio** + **lip sync**.
- **Consistency:** Same beat structure across locales; **visuals** and **speech** differ by market.
- **Dependencies:** Exact Google APIs, quotas, and whether **lip sync** is a single-model step or **TTS + video model** — **to be confirmed** against current Genmedia docs during implementation.
- **Hackathon simplification:** Single session, no persistence requirement beyond in-browser or ephemeral server storage if needed for demo.

---

## 7. Success criteria (hackathon / demo)

- End-to-end demo: **chat → image upload → select 3 regions → 3 downloadable videos**.
- Obvious **language** difference (EN / HI / ZH) and **visual locale** difference between clips.
- **Product** visibly consistent with upload in at least one hero shot per variant.

---

## 8. Open assumptions & decisions

| Topic | Assumption (change if you disagree) |
|--------|-------------------------------------|
| Script | One narrative; **localized lines** per region, not three unrelated concepts. |
| Video length | **~15 seconds** unless you specify otherwise. |
| Keyframe count | **Fixed small set** (e.g. 4–8) defined by agent or template. |
| “Nano Banana” | Treated as **still image generation** model name as specified; wire to actual API name in code. |

---

## 9. Risks (brief)

- **Lip sync + Mandarin/Hindi quality** may vary by API; have a **fallback narrative** for the demo (e.g. strongest locale first).
- **Full compositing** from one product photo is ambitious; scope **one strong composited moment** per video if time is tight.
