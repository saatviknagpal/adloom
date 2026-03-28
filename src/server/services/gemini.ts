import basicCopy from "@docs/basic_copy.json";
import { logBriefDebug } from "@/server/lib/brief-debug-log";
import {
  briefHasEmptyStringFields,
  mergeContextInference,
  parseJsonObject,
  seedEmptyThemeFromMood,
} from "@/server/services/basic-brief";

/** Google AI Gemini for discovery chat, keyframe agent, gap-fill, localization. Override with GEMINI_TEXT_MODEL. */
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-2.5-flash";

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

function buildDiscoverySystemPrompt(): string {
  return `You are Adloom's creative director. Your job is to take the user's ad concept and turn it into a complete script version by calling **commit_script_version**.

TEMPLATE (JSON — keys and nested shape; "description" strings explain intent):
${JSON.stringify(basicCopy, null, 2)}

You have ONE tool: **commit_script_version**. It saves a complete script version (scenes + characters) to the storyboard.

Rules:
- **CRITICAL: ALWAYS produce a text response.** After calling commit_script_version, you MUST ALSO produce a text message summarizing what you created. Never emit only a tool call with no text.
- **User-facing tone:** Reply in natural conversational prose only. **Never** show raw JSON, code fences, or schema dumps.
- When the user gives you enough info to construct scenes AND cast, call **commit_script_version** IMMEDIATELY. Do NOT ask for confirmation — just do it. Fill in reasonable defaults for any missing details (frame descriptions, camera movements, etc.).
- If the user gives partial info (e.g. a product but no ad concept), ask short targeted questions to get what you need, then commit.
- If the user asks you to "generate" or "draft" an ad, propose concrete scenes and cast in plain language, then commit immediately.
- Collect: brand, product, creative direction, the hook, scenes (1–5), and characters (1–3 cast members).

Scene breakdown rules:
- A scene = one continuous camera shot. Only create a new scene when there is a CUT.
- Each scene must be at most 8 seconds long.
- Aim for 1–5 scenes total. Each should have a clear purpose (hook, problem, solution, product showcase, CTA, etc.).
- Each scene needs:
  1. **action_description** — What happens: character actions, product interactions, narrative beat, emotional arc.
  2. **start_frame_description** — Opening composition: camera angle, shot size, lighting, setting, character positions, product placement. The BEFORE state.
  3. **end_frame_description** — Closing composition showing the END STATE after the action plays out. Must show narrative progression, not just a different angle.
  4. **camera_movement** — Camera motion across the shot (e.g. "slow dolly in", "pan left to right", "static").
  5. **dialogue** (optional) — Speaker, line, delivery_note. Use speaker "voiceover" for narration. Omit if no speech.
- Start and end frames define the visual range for video generation. They must show two clearly different moments.

commit_script_version args: label (string), scenes (array, 1–5), characters ({ talent_type, cast } with 1–3 cast members). Each scene: scene_number, start_time, end_time, action_description, start_frame_description, end_frame_description, camera_movement, and optionally dialogue. Each cast entry: role, description.

- Be concise. Do NOT generate images or videos. Avoid stereotypes.`;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> };

export type HistoryEntry = { role: "user" | "model"; parts: { text: string }[] };

// ---------------------------------------------------------------------------
// Keyframe generation phase — tools, prompt, streaming
// ---------------------------------------------------------------------------

const KEYFRAME_SYSTEM_PROMPT = `You are the visual director for Adloom, a locale-adaptive video ad generator.

You have an approved brief and scene list. Your job is to generate the visual assets for the ad.

You have two tools:
1. generate_character — create a reference image for ONE character in ONE locale. You MUST call this separately for EVERY character × locale combination. Use the "locale" parameter to specify which market this variant is for (e.g. "US", "IN", "CN").
2. generate_videos — generate video clips for all scenes using character references. The system looks up characters by locale to use the correct regional variants.

CRITICAL WORKFLOW — follow this EXACTLY:

**Step 1: Generate US characters first.**
For each character in the cast, call generate_character with locale="US" and a detailed visual prompt describing a person appropriate for the US market. Be specific about age, ethnicity, appearance, clothing, expression, and pose. Character prompts MUST describe a frontal/front-facing view against a plain solid-color or transparent background with studio-style even lighting.

**Step 2: Generate locale variants for EVERY other selected market.**
Check the pipeline state block for "Target locales". For each non-US locale (e.g. IN, CN), you MUST call generate_character AGAIN for EVERY character with:
- locale set to that market code (e.g. "IN", "CN")
- A REWRITTEN visual prompt that adapts the character's ethnicity and appearance for that region:
  - "IN" (India) → South Asian / Indian appearance, skin tone, facial features, hair appropriate for Indian people
  - "CN" (China) → East Asian / Chinese appearance, skin tone, facial features, hair appropriate for Chinese people
- Keep the same role, age range, gender, wardrobe style, expression, and pose direction as the US version
- Keep the same character name so the system can group them

**Step 3: Wait for all characters across ALL locales to be "ready".**
Check the pipeline state. Every character × locale cell must show "ready". If any are missing or failed, generate/regenerate them. Do NOT proceed until ALL are ready.

**Step 4: Ask user to review characters.**
Once all character × locale variants are generated, summarize what was created and ask the user to confirm they are happy with the results.

**Step 5: Generate videos.**
Only after user confirmation, call generate_videos with the target locales. The system will use the locale-specific character references you already generated.

Pipeline state rules:
- A "== Pipeline State (authoritative) ==" block is appended to each message. It shows characters grouped by locale and a grid showing which character × locale combinations exist.
- "Target locales" tells you which markets the user selected. You MUST generate characters for ALL of them.
- Do NOT generate characters already marked "ready" unless the user explicitly asks for a regeneration.
- When creating a NEW character, omit the "id" parameter.
- When REGENERATING an existing character, pass its "id" to create a new version.

General rules:
- Generate characters BEFORE videos so references are available.
- Be specific and visual in your prompts. Avoid vague language.
- Call one tool at a time. Wait for the result before calling the next.
- IMPORTANT: Do NOT call generate_videos until the user has reviewed the characters across all markets and explicitly approved them.
- When calling generate_videos, pass the user-selected target markets as the "locales" parameter.`;

const GENERATE_CHARACTER_TOOL = {
  type: "function" as const,
  function: {
    name: "generate_character",
    description:
      "Generate a reference image for ONE character in ONE locale. You must call this separately for every character × locale combination. Adapt the visual prompt to match the target market's ethnicity.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Character name/role, e.g. 'protagonist', 'the mom', 'barista'. Use the SAME name across locales so the system can group them.",
        },
        visualPrompt: {
          type: "string",
          description:
            "Detailed visual description for THIS locale's character. Include age, ethnicity appropriate for the locale, build, clothing, hairstyle, expression, and pose. MUST specify a frontal/front-facing pose against a plain solid-color or transparent background. Adapt ethnicity: US=diverse American, IN=South Asian/Indian, CN=East Asian/Chinese.",
        },
        locale: {
          type: "string",
          enum: ["US", "IN", "CN"],
          description: "Which market this character variant is for. Determines the region tag on the asset.",
        },
        id: {
          type: "string",
          description:
            "Existing character asset ID to regenerate. Creates a new version. Omit for brand-new characters.",
        },
      },
      required: ["name", "visualPrompt", "locale"],
    },
  },
};

const GENERATE_VIDEOS_TOOL = {
  type: "function" as const,
  function: {
    name: "generate_videos",
    description:
      "Generate video clips for all scenes using character references. Generates a final stitched video per locale. Only call this after the user has explicitly confirmed they want to proceed with video generation.",
    parameters: {
      type: "object",
      properties: {
        locales: {
          type: "array",
          items: { type: "string", enum: ["US", "IN", "CN"] },
          description: "Locales to generate videos for. Defaults to ['US']. Each additional locale gets localized dialogue. The user selects target markets in the UI.",
        },
      },
      required: [],
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
    name: GENERATE_VIDEOS_TOOL.function.name,
    description: GENERATE_VIDEOS_TOOL.function.description,
    parameters: GENERATE_VIDEOS_TOOL.function.parameters as unknown as import("@google/generative-ai").FunctionDeclarationSchema,
  },
];

/**
 * Build context message for the keyframe agent from session data.
 */
export function buildKeyframeContext(brief: string, scenesOrBeatsJson: string): string {
  return `Here is the approved brief and scene list for this ad.

Brief:
${brief}

Scenes (use scene indices 0..n-1 as beatIndex for keyframes):
${scenesOrBeatsJson}

Please begin by identifying the characters needed, generating their reference images, and then creating keyframes for each scene.`;
}

type AssetRow = {
  id: string;
  groupKey: string | null;
  version: number;
  uri: string | null;
  generationStatus: string;
  generationError: string | null;
  meta: string | null;
  shotIndex: number | null;
};

/**
 * Build a compact pipeline state block showing a character × locale grid and videos.
 */
export function buildPipelineStateBlock(
  charGroups: Record<string, AssetRow[]>,
  sceneCount: number,
  videoAssets?: AssetRow[],
  targetLocales?: string[],
): string {
  const locales = targetLocales?.length ? targetLocales : ["US"];
  const lines: string[] = ["== Pipeline State (authoritative) =="];
  lines.push(`Target locales: ${locales.join(", ")}`);

  const allAssets: AssetRow[] = [];
  for (const versions of Object.values(charGroups)) {
    for (const v of versions) allAssets.push(v);
  }

  // Build a map: characterName → locale → AssetRow
  const charNames = new Set<string>();
  const charGrid: Record<string, Record<string, AssetRow>> = {};
  for (const a of allAssets) {
    let locale = "US";
    let name = a.groupKey ?? a.id;
    try {
      const meta = a.meta ? JSON.parse(a.meta) : {};
      locale = meta.locale ?? "US";
      name = meta.name ?? name;
    } catch { /* ignore */ }
    const baseName = name;
    charNames.add(baseName);
    if (!charGrid[baseName]) charGrid[baseName] = {};
    charGrid[baseName][locale] = a;
  }

  lines.push("");
  lines.push("Characters (grid — you must fill every cell):");

  if (charNames.size === 0) {
    lines.push("  (none yet — generate characters for each locale listed above)");
  } else {
    const header = `  ${"Character".padEnd(20)} | ${locales.map((l) => l.padEnd(10)).join(" | ")}`;
    lines.push(header);
    lines.push("  " + "-".repeat(header.length - 2));

    for (const name of charNames) {
      const cells = locales.map((locale) => {
        const asset = charGrid[name]?.[locale];
        if (!asset) return "MISSING".padEnd(10);
        const status = formatAssetStatus(asset);
        return status.padEnd(10);
      });
      lines.push(`  ${name.padEnd(20)} | ${cells.join(" | ")}`);
    }

    lines.push("");
    lines.push("Character details:");
    for (const name of charNames) {
      for (const locale of locales) {
        const asset = charGrid[name]?.[locale];
        if (asset) {
          lines.push(`  - "${name}" (${locale}): [id: "${asset.id}", groupKey: "${asset.groupKey ?? ""}", version: ${asset.version}] ${formatAssetStatus(asset)}`);
        } else {
          lines.push(`  - "${name}" (${locale}): NOT GENERATED — call generate_character with name="${name}", locale="${locale}"`);
        }
      }
    }
  }

  if (sceneCount > 0) {
    lines.push("");
    lines.push("Videos:");
    if (!videoAssets || videoAssets.length === 0) {
      lines.push("  (none yet — generate ALL characters across ALL locales first, then call generate_videos)");
    } else {
      for (let i = 0; i < sceneCount; i++) {
        const vid = videoAssets.find((a) => a.shotIndex === i);
        const status = vid ? formatAssetStatus(vid) : "not_generated";
        const vidId = vid ? `, id: "${vid.id}"` : "";
        lines.push(`  - scene_${i}: [${status}${vidId}]`);
      }
    }
  }

  return lines.join("\n");
}

function formatAssetStatus(asset: AssetRow): string {
  if (asset.generationStatus === "ready" && asset.uri) return "ready";
  if (asset.generationStatus === "failed") return `failed (${asset.generationError ?? "unknown"})`;
  if (asset.generationStatus === "pending") return "pending";
  return "not_started";
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Stream keyframe generation chat with multi-turn tool calling.
 *
 * Keeps a single Gemini Chat session alive across rounds. When the model emits
 * tool calls, `executeTool` is invoked for each one and the results are sent
 * back as FunctionResponseParts so the model can decide what to do next.
 *
 * Text chunks and tool_call events are yielded to the caller for SSE streaming.
 */
export async function* streamKeyframeChat(
  history: HistoryEntry[],
  userMessage: string,
  executeTool: ToolExecutor,
): AsyncGenerator<StreamEvent> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({
    model: GEMINI_TEXT_MODEL,
    systemInstruction: KEYFRAME_SYSTEM_PROMPT,
    tools: [{ functionDeclarations: KEYFRAME_TOOLS_GEMINI }],
  });
  const chat = model.startChat({ history });

  const MAX_TOOL_ROUNDS = 20;
  let pendingMessage: string | import("@google/generative-ai").FunctionResponsePart[] = userMessage;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await chat.sendMessageStream(pendingMessage);
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield { type: "text", text };
      const calls = chunk.functionCalls();
      if (calls) {
        for (const call of calls) {
          toolCalls.push({ name: call.name, args: (call.args ?? {}) as Record<string, unknown> });
        }
      }
    }

    if (toolCalls.length === 0) break;

    const functionResponses: import("@google/generative-ai").FunctionResponsePart[] = [];

    for (const tc of toolCalls) {
      console.log(`[tool_call] ${tc.name}`, JSON.stringify(tc.args, null, 2));
      yield { type: "tool_call", name: tc.name, args: tc.args };
      const outcome = await executeTool(tc.name, tc.args);
      console.log(`[tool_result] ${tc.name}`, JSON.stringify(outcome, null, 2));
      functionResponses.push({
        functionResponse: { name: tc.name, response: outcome },
      });
    }

    pendingMessage = functionResponses;
  }
}

const COMMIT_SCRIPT_VERSION_TOOL = {
  type: "function" as const,
  function: {
    name: "commit_script_version",
    description:
      "Save a script version to the storyboard. Call this when you have BOTH scenes (≤5) AND cast (≤3). If the user provided a complete ad concept, commit immediately without asking for confirmation.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Version label e.g. 'v1 — first lock'" },
        scenes: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              scene_number: { type: "number" },
              start_time: { type: "number" },
              end_time: { type: "number" },
              action_description: { type: "string", description: "What happens during this scene: character actions, product interactions, narrative beat, emotional arc." },
              start_frame_description: { type: "string", description: "The BEFORE state: opening composition showing camera angle, shot size, lighting, setting, character positions, product placement." },
              end_frame_description: { type: "string", description: "The AFTER state: closing composition showing the end result of the action. Must depict what the scene looks like after the action has played out, not just a different camera angle on the same moment." },
              camera_movement: { type: "string", description: "Camera motion across the whole shot, e.g. 'slow dolly in', 'pan left to right', 'crane up', 'static', 'push in to close-up'." },
              dialogue: {
                type: "object",
                description: "Optional spoken lines during this scene. Omit if the scene has no speech.",
                properties: {
                  speaker: { type: "string", description: "Who speaks — character role (e.g. 'protagonist', 'barista') or 'voiceover'" },
                  line: { type: "string", description: "The exact words spoken" },
                  delivery_note: { type: "string", description: "Tone/emotion/pacing guidance, e.g. 'whispered, intimate', 'excited, upbeat'" },
                },
                required: ["speaker", "line", "delivery_note"],
              },
            },
            required: ["scene_number", "start_time", "end_time", "action_description", "start_frame_description", "end_frame_description", "camera_movement"],
          },
        },
        characters: {
          type: "object",
          properties: {
            talent_type: { type: "string" },
            cast: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  description: { type: "string" },
                },
                required: ["role", "description"],
              },
            },
          },
          required: ["talent_type", "cast"],
        },
      },
      required: ["label", "scenes", "characters"],
    },
  },
};

export async function* streamChat(
  history: HistoryEntry[],
  userMessage: string,
  executeTool?: ToolExecutor,
): AsyncGenerator<StreamEvent> {
  const discoveryInstruction = buildDiscoverySystemPrompt();
  const { GoogleGenerativeAI, FunctionCallingMode } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({
    model: GEMINI_TEXT_MODEL,
    systemInstruction: discoveryInstruction,
    tools: [{
      functionDeclarations: [
        {
          name: COMMIT_SCRIPT_VERSION_TOOL.function.name,
          description: COMMIT_SCRIPT_VERSION_TOOL.function.description,
          parameters: COMMIT_SCRIPT_VERSION_TOOL.function.parameters as unknown as import("@google/generative-ai").FunctionDeclarationSchema,
        },
      ],
    }],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
  });
  const chat = model.startChat({ history });

  let pendingMessage: string | import("@google/generative-ai").FunctionResponsePart[] = userMessage;
  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await chat.sendMessageStream(pendingMessage);
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield { type: "text", text };
      const calls = chunk.functionCalls();
      if (calls) {
        for (const call of calls) {
          const args = (call.args ?? {}) as Record<string, unknown>;
          console.log(`[tool_call] ${call.name}`, JSON.stringify(args, null, 2));
          toolCalls.push({ name: call.name, args });
          yield { type: "tool_call", name: call.name, args };
        }
      }
    }

    if (toolCalls.length === 0) break;

    const functionResponses: import("@google/generative-ai").FunctionResponsePart[] = [];
    for (const tc of toolCalls) {
      const response = executeTool
        ? await executeTool(tc.name, tc.args)
        : { success: true };
      functionResponses.push({
        functionResponse: { name: tc.name, response },
      });
    }
    pendingMessage = functionResponses;
  }
}

const LOCALIZATION_PROMPT = `You are localizing dialogue for a video ad. Given the scene list below, translate/adapt the dialogue for each requested locale.

Scenes:
{SCENES}

Locales to generate: {LOCALES}

Output a JSON object (no markdown fencing, pure JSON) with this structure:
{{
  "localized": {{
    "<LOCALE>": [
      {{
        "scene_number": <number>,
        "dialogue": {{
          "speaker": "<same speaker role as original>",
          "line": "<translated/adapted line in the locale's language>",
          "delivery_note": "<adapted delivery note>"
        }}
      }}
    ]
  }}
}}

Rules:
- For "IN", translate dialogue into natural Hindi (Devanagari script). Adapt cultural references for Indian audiences.
- For "CN", translate dialogue into natural Mandarin (Simplified Chinese). Adapt cultural references for Chinese audiences.
- For "US", keep the original English dialogue unchanged.
- If a scene has no dialogue in the original, omit it from that locale's array.
- Keep lines short and punchy — these are ad voiceovers, not essays.
- Preserve the speaker role names in English (e.g. "protagonist", "voiceover").
- The delivery_note should be adapted to feel natural in the target culture.`;

function stripJsonFromModelText(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  if (fence) return fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

const GAP_FILL_PROMPT = `You complete a short ad-production brief. You ONLY infer missing copy from fields that are already filled (brand, product, creative_direction, the_hook, scenes, characters.cast, etc.). Do not use generic template placeholders like "TBD" or "your brand here".

INPUT BRIEF (JSON):
{BRIEF}

Output requirements:
1. Return a single JSON object with the same top-level keys and nesting as the input: brand, product, creative_direction, the_hook, characters, scenes.
2. Copy every non-empty string from the input unchanged. For any string that is "" or whitespace-only, write a short, specific value consistent with the rest of the brief (especially scene action_description/start_frame_description/end_frame_description, dialogue if present, cast role/description, brand/product names).
2b. For creative_direction.theme: if mood is non-empty, the theme must align with that mood (same energy/vibe). Never replace mood with a contradictory theme label.
3. Do not change scene_number, start_time, end_time, camera_movement, or the structure of scenes[] or characters.cast[] — you may only fill empty strings inside those objects if any exist. Preserve dialogue objects as-is if present; do not add dialogue to scenes that have none.
4. Keep product.images as in the input unless the input already lists image URLs elsewhere in prose you can mirror (otherwise leave the array as-is).
5. Raw JSON only, no markdown fences.

If every string field is already non-empty, return the input JSON unchanged.`;

/**
 * Fills empty brief strings using the model; snapshot-backed scenes/characters structure is preserved via mergeContextInference.
 */
export async function enrichBriefEmptyFields(mergedBriefJson: string): Promise<string> {
  logBriefDebug("enrich: input (merged JSON, before seed)", mergedBriefJson);

  let brief: Record<string, unknown>;
  try {
    brief = JSON.parse(mergedBriefJson) as Record<string, unknown>;
  } catch {
    logBriefDebug("enrich: parse failed, returning raw input");
    return mergedBriefJson;
  }
  brief = seedEmptyThemeFromMood(brief);
  const briefAfterSeed = JSON.stringify(brief);
  logBriefDebug("enrich: after seedEmptyThemeFromMood", briefAfterSeed);

  if (!briefHasEmptyStringFields(brief)) {
    logBriefDebug("enrich: skip gap-fill (no empty string fields left)");
    return briefAfterSeed;
  }

  const prompt = GAP_FILL_PROMPT.replace("{BRIEF}", briefAfterSeed);
  logBriefDebug("enrich: gap-fill prompt (full)", prompt);
  logBriefDebug("enrich: gap-fill meta", {
    provider: "google_generative_ai",
    model: GEMINI_TEXT_MODEL,
    briefAfterSeedChars: briefAfterSeed.length,
  });

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({ model: GEMINI_TEXT_MODEL });
  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  logBriefDebug("enrich: model raw response (full)", raw || "(empty)");

  const extracted = stripJsonFromModelText(raw);
  logBriefDebug("enrich: extracted JSON substring", extracted);

  const inferred = parseJsonObject(extracted);
  logBriefDebug("enrich: parsed inferred object", inferred);
  if (Object.keys(inferred).length === 0) {
    logBriefDebug("enrich: inferred empty, using briefAfterSeed");
    return briefAfterSeed;
  }

  const merged = mergeContextInference(brief, inferred);
  const out = JSON.stringify(seedEmptyThemeFromMood(merged));
  logBriefDebug("enrich: final JSON after mergeContextInference + seed", out);
  return out;
}

export type LocalizedDialogue = {
  scene_number: number;
  dialogue: {
    speaker: string;
    line: string;
    delivery_note: string;
  };
};

export type LocalizationResult = Record<string, LocalizedDialogue[]>;

export async function localizeScenes(
  scenesJson: string,
  locales: string[],
): Promise<LocalizationResult> {
  const prompt = LOCALIZATION_PROMPT
    .replace("{SCENES}", scenesJson)
    .replace("{LOCALES}", locales.join(", "));

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({ model: GEMINI_TEXT_MODEL });
  const result = await model.generateContent(prompt);
  const raw = stripJsonFromModelText(result.response.text());

  try {
    const parsed = JSON.parse(raw) as { localized: LocalizationResult };
    return parsed.localized ?? {};
  } catch {
    console.error("[localize] Failed to parse localization response:", raw);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Character prompt localization — adapt character visuals per region
// ---------------------------------------------------------------------------

const CHARACTER_LOCALIZATION_PROMPT = `You are adapting character visual descriptions for a video ad that will run in a different market.

Original characters (designed for the US market):
{CHARACTERS}

Target market: {LOCALE}

For each character, rewrite the visual description so the character represents the target market's predominant ethnicity and cultural appearance, while keeping:
- The same role, age range, and gender
- The same wardrobe *style* (adapt specifics if culturally appropriate — e.g. "streetwear" stays streetwear but adapted to local fashion)
- The same pose direction (front-facing, studio lighting, plain background)
- The same energy/expression/demeanor

Output a JSON array (no markdown fencing, pure JSON):
[
  {{
    "name": "<same character name/role>",
    "prompt": "<rewritten visual description for the target market>"
  }}
]

Rules:
- For "IN" (India): Characters should be South Asian / Indian in appearance.
- For "CN" (China): Characters should be East Asian / Chinese in appearance.
- Be specific about skin tone, facial features, hair texture/style as appropriate for the region.
- Do NOT change the character's role or the number of characters.
- Keep descriptions detailed and suitable for image generation (age, build, clothing, hairstyle, expression, pose).`;

export type LocalizedCharacter = {
  name: string;
  prompt: string;
};

export async function localizeCharacterPrompts(
  characters: { name: string; prompt: string }[],
  locale: string,
): Promise<LocalizedCharacter[]> {
  const charsJson = JSON.stringify(characters, null, 2);
  const prompt = CHARACTER_LOCALIZATION_PROMPT
    .replace("{CHARACTERS}", charsJson)
    .replace("{LOCALE}", locale);

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({ model: GEMINI_TEXT_MODEL });
  const result = await model.generateContent(prompt);
  const raw = stripJsonFromModelText(result.response.text());

  try {
    const parsed = JSON.parse(raw) as LocalizedCharacter[];
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    console.error("[localizeChars] Failed to parse character localization response:", raw);
    return [];
  }
}
