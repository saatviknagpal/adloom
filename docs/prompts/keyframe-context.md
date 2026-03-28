# Keyframe Context Message

> **Source:** `src/server/services/gemini.ts` — `buildKeyframeContext(brief, scenesOrBeatsJson)`
>
> This is the user message injected on the first keyframe turn. `{BRIEF}` is the full master brief JSON. `{SCENES}` is the canonical scene/beat list JSON.

---

Here is the approved brief and scene list for this ad.

Brief:
{BRIEF}

Scenes (use scene indices 0..n-1 as beatIndex for keyframes):
{SCENES}

Please begin by identifying the characters needed, generating their reference images, and then creating keyframes for each scene.
