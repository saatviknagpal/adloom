import basicCopy from "@docs/basic_copy.json";
import masterBaseline from "@docs/master_baseline.json";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_NAME = "google/gemini-2.0-flash-001";

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY (or GEMINI_API_KEY) is not set");
  return key;
}

function isOpenRouter(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

const SYSTEM_PROMPT = `You are the creative strategist for Adloom, a locale-adaptive video ad generator.

Your job in this chat:
1. Help the user define their ad concept.
2. Build a beat list (hook → problem → product reveal → CTA) with spoken lines localized later to US / India / China.
3. Iterate until they are satisfied.

Discovery checklist — BEFORE you propose the FIRST beat list, cover only these areas (same structure as our brief schema). Ask 1–2 areas per message. If the user already answered earlier, do not ask again.

Areas (in order):
A. Brand — name and tagline (if any)
B. Product — name, core USP, optional product image URLs if they have them
C. Creative direction — theme and mood
D. The hook — hook type, what we see in the first ~1.5s, what we hear in the first ~1.5s
E. Characters — talent type (e.g. UGC vs AI avatar vs no on-screen talent) and brief cast description (role + look)
F. Do not ask for a full scene-by-scene shot list in chat; scene timing and camera will be derived from the approved beat list later.

If the user says skip, "you decide", or "don't know" — note it once and move on. Do not re-ask.

Hard rule — first beat list:
- Do NOT present a numbered beat list and do NOT call save_beat_list until A–E are each answered OR explicitly skipped / deferred to you.
- Exception: if the user explicitly says "skip all questions", "just write the script", or "go straight to beats", you may go straight to a beat list.

After the first beat list, revisions are normal — user can ask to change beats; call save_beat_list whenever you show an updated beat list.

Other rules:
- Be concise. No marketing fluff.
- Do NOT generate images or videos.
- Do NOT make assumptions about religion, politics, caste, or stereotypes.
- Adapt locales through setting and context — not ethnic shortcuts.
- ALWAYS call save_beat_list when you present a beat list (new or revised).
- Do NOT skip the tool call when showing beats.`;

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Keyframe generation phase — tools, prompt, streaming
// ---------------------------------------------------------------------------

const KEYFRAME_SYSTEM_PROMPT = `You are the visual director for Adloom, a locale-adaptive video ad generator.

You have already approved a beat list and localized copy. Your job now is to generate the visual assets for the ad.

You have two tools:
1. generate_character — create a reference image for a character that appears in the ad.
2. generate_keyframe — create a keyframe (scene image) for a specific beat, optionally compositing characters and product.

Workflow:
1. Review the beat list and the pipeline state block to see which characters still need generating.
2. For each character not yet marked "ready", call generate_character with a detailed visual description. Be specific about age, appearance, clothing, expression, and pose.
3. Once ALL characters are generated, STOP making tool calls. Summarize the characters created and ask the user if they are satisfied with the results. If the user wants changes, regenerate as requested.
4. Only proceed to keyframe generation (generate_keyframe) when the user explicitly confirms they are happy with the characters and gives permission to move on.
5. Write image prompts that are concrete and cinematic — describe camera angle, lighting, composition, setting, and action.

Pipeline state rules:
- A "== Pipeline State (authoritative) ==" block is appended to each message. It shows the current state of all characters.
- Do NOT generate characters already marked "ready" unless the user explicitly asks for a regeneration.
- When creating a NEW character, omit the "id" parameter from the tool call.
- When REGENERATING an existing character, pass the "id" of the character to replace. This creates a new version.
- Use the "groupKey" shown in the state block to reference characters.

General rules:
- Generate characters BEFORE keyframes so references are available.
- Be specific and visual in your prompts. Avoid vague language.
- Each keyframe prompt should be self-contained — include all visual details needed.
- When referencing characters or products, mention them by name in the prompt AND pass their IDs.
- Do NOT skip any beats — every beat needs at least one keyframe.
- Call one tool at a time. Wait for the result before calling the next.
- IMPORTANT: Do NOT call generate_keyframe until the user has reviewed the characters and explicitly approved them. After generating all characters, ask for confirmation before proceeding.
- IMPORTANT: Only generate assets for the US / English locale. Ignore other locales for now.`;

const GENERATE_CHARACTER_TOOL = {
  type: "function" as const,
  function: {
    name: "generate_character",
    description:
      "Generate a reference image for a character in the ad. Call this before generating keyframes that include this character.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Character name/role, e.g. 'protagonist', 'the mom', 'barista'",
        },
        visualPrompt: {
          type: "string",
          description:
            "Detailed visual description for the character reference image. Include age, ethnicity, build, clothing, hairstyle, expression, pose, and background. Be specific and cinematic.",
        },
        id: {
          type: "string",
          description:
            "Existing character asset ID. If provided, creates a new version of this character instead of a new character. Omit for brand-new characters.",
        },
      },
      required: ["name", "visualPrompt"],
    },
  },
};

const GENERATE_KEYFRAME_TOOL = {
  type: "function" as const,
  function: {
    name: "generate_keyframe",
    description:
      "Generate a keyframe image for a specific beat in the ad. Optionally reference character and product images for visual consistency.",
    parameters: {
      type: "object",
      properties: {
        beatIndex: {
          type: "number",
          description: "The index of the beat this keyframe belongs to (from the beat list)",
        },
        label: {
          type: "string",
          description: "Short label for this keyframe, e.g. 'hook-wide-shot', 'product-closeup'",
        },
        visualPrompt: {
          type: "string",
          description:
            "Detailed visual prompt for the scene. Include camera angle, lighting, composition, setting, characters present, action, and mood. Be cinematic and specific.",
        },
        characterIds: {
          type: "array",
          items: { type: "string" },
          description: "Asset IDs of characters to use as reference images for visual consistency",
        },
        includeProductImage: {
          type: "boolean",
          description: "Whether to include the uploaded product image as a reference",
        },
      },
      required: ["beatIndex", "label", "visualPrompt"],
    },
  },
};

const KEYFRAME_TOOLS_GEMINI = [
  {
    name: GENERATE_CHARACTER_TOOL.function.name,
    description: GENERATE_CHARACTER_TOOL.function.description,
    parameters: GENERATE_CHARACTER_TOOL.function.parameters as unknown as import("@google/generative-ai").FunctionDeclarationSchema,
  },
  {
    name: GENERATE_KEYFRAME_TOOL.function.name,
    description: GENERATE_KEYFRAME_TOOL.function.description,
    parameters: GENERATE_KEYFRAME_TOOL.function.parameters as unknown as import("@google/generative-ai").FunctionDeclarationSchema,
  },
];

/**
 * Build context message for the keyframe agent from session data.
 */
export function buildKeyframeContext(brief: string, beats: string): string {
  return `Here is the approved brief and beat list for this ad.

Brief (includes localized scripts):
${brief}

Beat list:
${beats}

Please begin by identifying the characters needed, generating their reference images, and then creating keyframes for each beat.`;
}

/**
 * Build a compact state block from character groups for the agent loop.
 * Only shows the latest version of each group.
 */
export function buildCharacterStateBlock(
  charGroups: Record<string, { id: string; groupKey: string | null; version: number; uri: string | null; generationStatus: string; generationError: string | null; meta: string | null }[]>,
): string {
  const lines: string[] = ["== Pipeline State (authoritative) ==", "Characters:"];

  const keys = Object.keys(charGroups);
  if (keys.length === 0) {
    lines.push("  (none yet — review the beat list and generate all needed characters)");
    return lines.join("\n");
  }

  for (const gk of keys) {
    const versions = charGroups[gk];
    const latest = versions[0];
    if (!latest) continue;

    const name = latest.meta ? (() => { try { return JSON.parse(latest.meta).name; } catch { return gk; } })() : gk;
    let statusStr: string;
    if (latest.generationStatus === "ready" && latest.uri) {
      statusStr = `ready (uri: ${latest.uri})`;
    } else if (latest.generationStatus === "failed") {
      statusStr = `failed (error: ${latest.generationError ?? "unknown"})`;
    } else if (latest.generationStatus === "pending") {
      statusStr = "pending";
    } else {
      statusStr = "not_started";
    }

    lines.push(`- [groupKey: "${gk}", id: "${latest.id}", version: ${latest.version}] "${name}" -- ${statusStr}`);
  }

  return lines.join("\n");
}

/**
 * Stream keyframe generation chat. Gemini acts as visual director,
 * calling generate_character and generate_keyframe tools.
 * Tool execution is handled by the caller (the API route).
 */
export async function* streamKeyframeChat(
  history: HistoryEntry[],
  userMessage: string,
): AsyncGenerator<StreamEvent> {
  if (!isOpenRouter()) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(getApiKey());
    const model = client.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: KEYFRAME_SYSTEM_PROMPT,
      tools: [{ functionDeclarations: KEYFRAME_TOOLS_GEMINI }],
    });
    const chat = model.startChat({ history });
    const result = await chat.sendMessageStream(userMessage);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield { type: "text", text };
      const calls = chunk.functionCalls();
      if (calls) {
        for (const call of calls) {
          yield { type: "tool_call", name: call.name, args: (call.args ?? {}) as Record<string, unknown> };
        }
      }
    }
    return;
  }

  const messages: { role: string; content: string }[] = [
    { role: "system", content: KEYFRAME_SYSTEM_PROMPT },
  ];
  for (const entry of history) {
    messages.push({
      role: entry.role === "model" ? "assistant" : "user",
      content: entry.parts.map((p) => p.text).join(""),
    });
  }
  messages.push({ role: "user", content: userMessage });

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://adloom.dev",
      "X-Title": "Adloom",
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages,
      tools: [GENERATE_CHARACTER_TOOL, GENERATE_KEYFRAME_TOOL],
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallBuffers: Record<number, { name: string; argsStr: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        for (const tc of Object.values(toolCallBuffers)) {
          try {
            const args = JSON.parse(tc.argsStr);
            yield { type: "tool_call", name: tc.name, args };
          } catch { /* malformed */ }
        }
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: "text", text: delta.content };
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (tc.function?.name) {
              toolCallBuffers[idx] = { name: tc.function.name, argsStr: tc.function.arguments ?? "" };
            } else if (tc.function?.arguments && toolCallBuffers[idx]) {
              toolCallBuffers[idx].argsStr += tc.function.arguments;
            }
          }
        }
      } catch { /* skip */ }
    }
  }

  for (const tc of Object.values(toolCallBuffers)) {
    try {
      const args = JSON.parse(tc.argsStr);
      yield { type: "tool_call", name: tc.name, args };
    } catch { /* malformed */ }
  }
}

const SAVE_BEAT_LIST_TOOL = {
  type: "function" as const,
  function: {
    name: "save_beat_list",
    description:
      "Save or update the current beat list / ad script. Call this whenever you present a new or revised beat list to the user.",
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Short label for this version, e.g. 'Initial draft', 'Warmer tone', 'Shorter CTA'",
        },
        beats: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              label: { type: "string" },
              description: { type: "string" },
              spokenLine: { type: "string" },
              durationSec: { type: "number" },
            },
            required: ["index", "label", "description", "spokenLine", "durationSec"],
          },
        },
      },
      required: ["label", "beats"],
    },
  },
};

type HistoryEntry = { role: "user" | "model"; parts: { text: string }[] };

function toOpenAIMessages(history: HistoryEntry[], userMessage: string) {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  for (const entry of history) {
    messages.push({
      role: entry.role === "model" ? "assistant" : "user",
      content: entry.parts.map((p) => p.text).join(""),
    });
  }

  messages.push({ role: "user", content: userMessage });
  return messages;
}

export async function* streamChat(
  history: HistoryEntry[],
  userMessage: string,
): AsyncGenerator<StreamEvent> {
  if (!isOpenRouter()) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(getApiKey());
    const model = client.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: SYSTEM_PROMPT,
      tools: [{
        functionDeclarations: [{
          name: SAVE_BEAT_LIST_TOOL.function.name,
          description: SAVE_BEAT_LIST_TOOL.function.description,
          parameters: SAVE_BEAT_LIST_TOOL.function.parameters as unknown as import("@google/generative-ai").FunctionDeclarationSchema,
        }],
      }],
    });
    const chat = model.startChat({ history });
    const result = await chat.sendMessageStream(userMessage);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield { type: "text", text };
      const calls = chunk.functionCalls();
      if (calls) {
        for (const call of calls) {
          yield { type: "tool_call", name: call.name, args: (call.args ?? {}) as Record<string, unknown> };
        }
      }
    }
    return;
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://adloom.dev",
      "X-Title": "Adloom",
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: toOpenAIMessages(history, userMessage),
      tools: [SAVE_BEAT_LIST_TOOL],
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const toolCallBuffers: Record<number, { name: string; argsStr: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        for (const tc of Object.values(toolCallBuffers)) {
          try {
            const args = JSON.parse(tc.argsStr);
            yield { type: "tool_call", name: tc.name, args };
          } catch {
            // malformed tool call args
          }
        }
        return;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "text", text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (tc.function?.name) {
              toolCallBuffers[idx] = { name: tc.function.name, argsStr: tc.function.arguments ?? "" };
            } else if (tc.function?.arguments) {
              if (toolCallBuffers[idx]) {
                toolCallBuffers[idx].argsStr += tc.function.arguments;
              }
            }
          }
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  for (const tc of Object.values(toolCallBuffers)) {
    try {
      const args = JSON.parse(tc.argsStr);
      yield { type: "tool_call", name: tc.name, args };
    } catch {
      // malformed
    }
  }
}

const BEAT_EXTRACTION_PROMPT = `The following text contains an ad beat list. Extract it as JSON (no markdown fencing, pure JSON):
{
  "label": "short label for this version",
  "beats": [
    { "index": 0, "label": "hook", "description": "...", "spokenLine": "...", "durationSec": 3 }
  ]
}

Only include beats that have a clear label and spoken line. If no beat list is found, return null.

Text:
`;

export async function extractBeatsFromText(text: string): Promise<string | null> {
  const prompt = BEAT_EXTRACTION_PROMPT + text;

  if (!isOpenRouter()) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(getApiKey());
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const raw = result.response.text().replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return raw === "null" ? null : raw;
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://adloom.dev",
      "X-Title": "Adloom",
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content ?? "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return raw === "null" ? null : raw;
}

const LOCALIZATION_PROMPT = `Given the following approved beat list, generate localized spoken lines for each beat.

Beat list:
{BEATS}

Output a JSON object (no markdown fencing, pure JSON):
{{
  "product": "infer from beats",
  "brandName": "infer from beats",
  "targetAudience": "infer from beats",
  "tone": "infer from beats",
  "offer": "infer from beats",
  "visualStyle": "infer from beats",
  "beats": <the beats array as-is>,
  "localizedScripts": {{
    "US": {{ "lines": ["English line per beat..."] }},
    "IN": {{ "lines": ["Hindi line per beat (Devanagari)..."] }},
    "CN": {{ "lines": ["Mandarin line per beat (Simplified Chinese)..."] }}
  }}
}}

Rules:
- localizedScripts.US.lines should match spokenLine per beat.
- localizedScripts.IN.lines should be natural Hindi (Devanagari script).
- localizedScripts.CN.lines should be natural Mandarin (Simplified Chinese).
- Keep lines short and punchy — these are ad voiceovers, not essays.`;

export async function localizeBrief(beatsJson: string): Promise<string> {
  const prompt = LOCALIZATION_PROMPT.replace("{BEATS}", beatsJson);

  if (!isOpenRouter()) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(getApiKey());
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text();
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://adloom.dev",
      "X-Title": "Adloom",
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Master Brief generation — single Gemini call at approval time
// ---------------------------------------------------------------------------

const MASTER_BRIEF_PROMPT = `You are an expert ad agency creative director. Given a chat conversation and an approved beat list for a video ad, generate a complete production brief in JSON.

Merge rules (critical):
1. Anything the user clearly stated in the chat MUST appear in the output and overrides defaults.
2. For fields the user did not specify, or where they said skip / "you decide" / "I don't know" — use BASELINE_DEFAULTS below as the starting point, then adjust only as needed to stay consistent with brand, product, and beats.
3. Where neither chat nor baseline gives a sensible value, infer from the brand, product, and beat list using creative best practices.

The distilled creative shape we care about (align script.the_hook and creative_direction.the_hook with this naming where helpful: visual + audio for hook; theme + mood under creative):
QUESTION_SCHEMA:
{QUESTION_SCHEMA}

BASELINE_DEFAULTS (fallback when user skipped or did not specify):
{BASELINE_DEFAULTS}

Approved beat list:
{BEATS}

Chat history (for context — extract brand, product, audience, tone, offer, and any customization answers from this):
{CHAT_HISTORY}

Output a single JSON object (no markdown fencing, pure JSON) following this EXACT schema:

{{
  "client": {{
    "brand_name": "string",
    "industry": "string"
  }},
  "product": {{
    "name": "string",
    "category": "string",
    "tagline": "string or empty",
    "usp": "the ONE thing this ad communicates",
    "key_features": ["top 2-3 features"]
  }},
  "campaign": {{
    "goal": "awareness|consideration|conversion|launch|app_install",
    "offer": {{ "has_offer": false, "offer_text": "", "promo_code": "" }},
    "cta": {{ "text": "Shop Now or similar", "url": "" }}
  }},
  "target_cohort": {{
    "user_intent": "cold_audience|warm_prospect|retargeting",
    "demographics": {{
      "age_range": {{ "min": 18, "max": 34 }},
      "gender": "all|male|female",
      "locations": ["US", "IN", "CN"],
      "languages": ["English", "Hindi", "Mandarin"]
    }},
    "psychographics": {{
      "interests": ["list"],
      "behaviors": ["list"],
      "pain_points": ["list"],
      "lifestyle": "string",
      "values": ["list"]
    }},
    "device_preference": "mobile|desktop|all"
  }},
  "delivery": {{
    "platforms": ["instagram_reels", "tiktok", "youtube_shorts"],
    "aspect_ratios": ["9:16"],
    "resolution": "1080p",
    "fps": 30
  }},
  "creative_direction": {{
    "overall_theme": "string",
    "mood": "string",
    "tone": "humorous|serious|inspirational|edgy|luxurious|casual|urgent|nostalgic|playful|authoritative",
    "visual_style": "live_action|animation_2d|animation_3d|motion_graphics|mixed_media|ai_generated|ugc_native",
    "pacing": "fast_cuts|slow_build|single_shot|dynamic_accelerating|rhythmic",
    "the_hook": {{
      "type": "visual_surprise|bold_claim|question|product_in_action|pattern_interrupt|relatable_moment|sound_hook|text_hook",
      "content": "what happens in first 1.5 seconds",
      "audio_element": "what viewer hears in first 1.5 seconds"
    }},
    "mandatory_inclusions": ["product visible in first 3s", "logo on end card"],
    "strict_exclusions": ["no stereotypes", "no stock footage look"]
  }},
  "color_palette": {{
    "primary": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "background": "#hex",
    "text_color": "#hex"
  }},
  "typography": {{
    "primary_font": "font name",
    "secondary_font": "font name"
  }},
  "script": {{
    "duration_seconds": <total from beats>,
    "scene_breakdown": [
      {{
        "scene_number": 1,
        "start_time": 0.0,
        "end_time": <from beat durationSec>,
        "visual_description": "detailed — what is visually happening, composition, lighting, setting, product placement",
        "on_screen_text": "short text if any, under 6 words",
        "text_animation": "fade_in|slide_up|pop|none",
        "dialogue": {{
          "speaker": "narrator or character name",
          "line": "spoken line from beat",
          "delivery_note": "vocal direction"
        }},
        "camera": {{
          "shot_type": "close_up|medium|wide|overhead|pov",
          "movement": "static|pan_left|zoom_in|tracking|dolly_in|handheld_shake",
          "transition_in": "cut|dissolve|whip_pan|morph|none"
        }}
      }}
    ],
    "end_card": {{
      "duration_seconds": 2.0,
      "logo_placement": "center",
      "text": "tagline or CTA",
      "cta_button": true
    }}
  }},
  "characters": {{
    "talent_type": "ai_avatar|real_actor|no_talent|hand_model",
    "cast": [
      {{
        "role": "main presenter or product user",
        "description": "brief visual description",
        "age_range": "25-30",
        "gender": "string",
        "wardrobe": "clothing direction",
        "demeanor": "energy and body language"
      }}
    ]
  }},
  "audio": {{
    "voiceover": {{
      "enabled": true,
      "gender": "string",
      "tone": "Energetic|Calm|Conversational",
      "accent": "Neutral American",
      "script": "full VO script, 15-25 words max for a 10s ad"
    }},
    "music": {{
      "style": "genre",
      "tempo": "slow|medium|fast|builds_to_climax",
      "mood": "string"
    }}
  }},
  "localization": {{
    "versions_needed": [
      {{
        "language": "Hindi",
        "locale": "hi-IN",
        "adapted_script": "full Hindi VO in Devanagari",
        "cultural_notes": "cultural adaptations for India"
      }},
      {{
        "language": "Mandarin",
        "locale": "zh-CN",
        "adapted_script": "full Mandarin VO in Simplified Chinese",
        "cultural_notes": "cultural adaptations for China"
      }}
    ]
  }}
}}

Rules:
- Infer brand colors from your knowledge of the brand (e.g., Coca-Cola = red + white).
- Infer audience psychographics from the target demographic.
- scene_breakdown MUST have one entry per beat in the approved beat list, with cumulative timestamps.
- visual_description for each scene must be specific and cinematic — camera angles, lighting, composition, setting.
- Do NOT output markdown fences. Output raw JSON only.
- Localization: adapt the script culturally, not just translate word-for-word.`;

export async function generateMasterBrief(
  chatHistory: string,
  beatsJson: string,
): Promise<string> {
  const prompt = MASTER_BRIEF_PROMPT
    .replace("{QUESTION_SCHEMA}", JSON.stringify(basicCopy, null, 2))
    .replace("{BASELINE_DEFAULTS}", JSON.stringify(masterBaseline, null, 2))
    .replace("{BEATS}", beatsJson)
    .replace("{CHAT_HISTORY}", chatHistory);

  if (!isOpenRouter()) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(getApiKey());
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text();
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://adloom.dev",
      "X-Title": "Adloom",
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

