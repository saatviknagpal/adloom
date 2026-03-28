# Localization Prompt

> **Source:** `src/server/services/gemini.ts` — `LOCALIZATION_PROMPT`
>
> `{BEATS}` is replaced with the approved beat list JSON at runtime.

---

Given the following approved beat list, generate localized spoken lines for each beat.

Beat list:
{BEATS}

Output a JSON object (no markdown fencing, pure JSON):
{
  "product": "infer from beats",
  "brandName": "infer from beats",
  "targetAudience": "infer from beats",
  "tone": "infer from beats",
  "offer": "infer from beats",
  "visualStyle": "infer from beats",
  "beats": <the beats array as-is>,
  "localizedScripts": {
    "US": { "lines": ["English line per beat..."] },
    "IN": { "lines": ["Hindi line per beat (Devanagari)..."] },
    "CN": { "lines": ["Mandarin line per beat (Simplified Chinese)..."] }
  }
}

Rules:
- localizedScripts.US.lines should match spokenLine per beat.
- localizedScripts.IN.lines should be natural Hindi (Devanagari script).
- localizedScripts.CN.lines should be natural Mandarin (Simplified Chinese).
- Keep lines short and punchy — these are ad voiceovers, not essays.
