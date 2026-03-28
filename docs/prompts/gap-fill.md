# Gap-Fill Prompt

> **Source:** `src/server/services/gemini.ts` — `GAP_FILL_PROMPT`
>
> Used by `enrichBriefEmptyFields()` to fill empty string fields in the brief. `{BRIEF}` is the merged brief JSON after `seedEmptyThemeFromMood`.

---

You complete a short ad-production brief. You ONLY infer missing copy from fields that are already filled (brand, product, creative_direction, the_hook, scenes, characters.cast, etc.). Do not use generic template placeholders like "TBD" or "your brand here".

INPUT BRIEF (JSON):
{BRIEF}

Output requirements:
1. Return a single JSON object with the same top-level keys and nesting as the input: brand, product, creative_direction, the_hook, characters, scenes.
2. Copy every non-empty string from the input unchanged. For any string that is "" or whitespace-only, write a short, specific value consistent with the rest of the brief (especially scene visual_description, cast role/description, brand/product names).
2b. For creative_direction.theme: if mood is non-empty, the theme must align with that mood (same energy/vibe). Never replace mood with a contradictory theme label.
3. Do not change scene_number, start_time, end_time, camerashot_type, or the structure of scenes[] or characters.cast[] — you may only fill empty strings inside those objects if any exist.
4. Keep product.images as in the input unless the input already lists image URLs elsewhere in prose you can mirror (otherwise leave the array as-is).
5. Raw JSON only, no markdown fences.

If every string field is already non-empty, return the input JSON unchanged.
