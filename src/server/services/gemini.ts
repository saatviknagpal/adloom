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

function buildDiscoverySystemPrompt(draftBriefJson: string): string {
  return `You are Adloom's discovery agent. Your job is ONLY to fill the product brief using the template structure below.

TEMPLATE (JSON — keys and nested shape you must use; "description" strings explain intent):
${JSON.stringify(basicCopy, null, 2)}

CURRENT DRAFT (on the server — merge factual updates via update_draft_brief):
${draftBriefJson}

Rules:
- Ask short, targeted questions. Record ONLY what the user clearly states (or what is explicit in prior messages). Do not invent brand facts, products, or copy.
- **User-facing tone:** Reply in natural conversational prose only. **Never** show raw JSON, code fences (\`\`\`), or "here's the JSON" blocks to the user. Tools persist data; the user should not see schema dumps.
- Whenever the user confirms a fact (brand, product, theme, mood, hook, etc.), call **update_draft_brief** in the **same turn** with **patch_json** — do not rely on pasting JSON in chat instead of the tool.
- Collect fields from the template: brand, product, creative_direction, the_hook, and especially **scenes** (at most 5) and **characters** (talent_type + cast, at most 3 people).
- For a single vibe word (e.g. "exciting", "cozy"), set **creative_direction.theme** to a short creative umbrella phrase that includes it, and **mood** to match — do not leave theme empty while only mood is set, or approve-time cleanup may mis-infer theme from scenes alone.
- Before committing a version, confirm with the user: e.g. "Is that everything you want for scenes?" and "Is that the full cast?" Both must be confirmed before commit_script_version.
- If the user asks you to "generate" or "draft" scenes or characters from context, propose concrete scenes (≤5) and cast (≤3) in **plain language**, then confirm before committing.

Scene breakdown rules:
- A scene = one continuous camera shot. Only create a new scene when there is a CUT to a different shot (different camera angle, different location, different subject). Do NOT split a single continuous shot into multiple scenes — that causes visual inconsistency between frames.
- Each scene must be at most 8 seconds long. If the narrative requires a longer moment, break it into separate shots (each with its own camera angle and framing) rather than stretching one shot.
- Aim for 1–5 scenes total. Each scene should have a clear purpose (hook, problem, solution, product showcase, CTA, etc.).
- Each scene needs THREE description fields, a camera movement, and optional dialogue:
  1. **action_description** — What happens: character actions, product interactions, the narrative beat, and the emotional arc. Describe the story, not just visuals.
  2. **start_frame_description** — The OPENING composition: camera angle, shot size, lighting, setting, character positions, product placement. Be cinematic and specific — this becomes the start keyframe image. This is the BEFORE state of the action.
  3. **end_frame_description** — The CLOSING composition showing the END STATE of the action described in action_description. The end frame must depict what the scene looks like AFTER the action has played out — not just a different camera angle on the same moment. For example, if the action is "the man reaches for the bottle and picks it up," the start frame shows the bottle on the table and the end frame shows the man holding the bottle. If the action is "she takes a sip and smiles," the start frame shows her raising the bottle and the end frame shows her smiling with the bottle lowered. The camera angle may also change, but the key difference is the NARRATIVE PROGRESSION, not just a camera move.
  4. **camera_movement** — The camera motion across the entire shot (e.g. "slow dolly in", "pan left to right", "crane up", "handheld tracking", "static", "push in to close-up", "pull back to reveal"). This describes how the camera moves from the start frame to the end frame.
  5. **dialogue** (optional) — Any spoken lines during the scene. Include **speaker** (who says it — character role or "voiceover"), **line** (the exact words spoken), and **delivery_note** (tone/emotion/pacing, e.g. "whispered, intimate", "excited, fast-paced", "calm and authoritative"). Omit dialogue entirely for scenes with no speech. If it's a voiceover narration, use speaker "voiceover".
- The start and end frames define the visual range for video interpolation between them. They must show two clearly different moments in the action so the resulting video has meaningful motion and narrative progression.

- Call **commit_script_version** ONLY after explicit confirmation of BOTH the final scene list AND the final character list for this version. Arguments: label (string), scenes (array, 1–5 items), characters ({ talent_type, cast } with 1–3 cast members). Each scene: scene_number, start_time, end_time, action_description, start_frame_description, end_frame_description, camera_movement, and optionally dialogue ({ speaker, line, delivery_note }). Each cast entry: role, description.
- Do NOT use any legacy beat-list format. No save_beat_list.
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
1. generate_character — create a reference image for a character that appears in the ad.
2. generate_keyframe — create a start or end keyframe (scene image) for a specific scene, compositing characters and product.

Workflow:
1. Review the scene list and the pipeline state block to see which characters still need generating.
2. For each character not yet marked "ready", call generate_character with a detailed visual description. Be specific about age, appearance, clothing, expression, and pose. Character prompts MUST describe a frontal/front-facing view against a plain solid-color or transparent background with studio-style even lighting. Do NOT include environmental backgrounds — those belong in keyframes, not character references.
3. Once ALL characters are generated, STOP making tool calls. Summarize the characters created and ask the user if they are satisfied with the results. If the user wants changes, regenerate as requested.
4. Only proceed to keyframe generation when the user explicitly confirms they are happy with the characters.
5. For each scene, generate TWO keyframes — a start frame and an end frame (see Temporal Pairs rule below). Check the pipeline state block to see which scenes still need keyframes and skip any already marked "ready".
6. After ALL keyframes (start + end for every scene) are generated, summarize the results and ask the user if they are satisfied. If the user wants changes, regenerate specific keyframes as requested.

Temporal Pairs rule:
- Every scene MUST have exactly two keyframes: a Start Frame and an End Frame.
- Call generate_keyframe with keyframeType "start" and label "scene_[N]_start" for the start frame.
- Call generate_keyframe with keyframeType "end" and label "scene_[N]_end" for the end frame.
- The Start Frame represents the first moment of the scene (the opening composition).
- The End Frame must show a CLEARLY DIFFERENT camera angle, shot size, or composition from the Start Frame. Think of it as a real film cut within the same scene — e.g., wide establishing shot → tight close-up, over-the-shoulder → frontal reaction shot, high angle → eye level. A subtle zoom or tiny reframe is NOT enough; the two frames must be visually distinct at a glance.
- Both frames share the same environment, lighting, and characters — what changes is the camera position/lens and character pose/action, not the setting.
- The start-frame image is automatically attached as a reference when generating the end frame. Use this to maintain environmental consistency while making a bold camera move.

Cross-scene continuity rule:
- When generating scene_[N]_start (for N > 0), the end frame of the previous scene (scene_[N-1]_end) is automatically attached as a reference image if available.
- Use this to maintain visual continuity across scene transitions — consistent lighting direction, color grade, and spatial relationships where scenes share a location or follow a continuous action.

Character Reference rule (Asset Link):
- When a scene includes a character, you MUST pass their asset IDs in characterIds. This is mandatory, not optional.
- In your visualPrompt, refer to the character as "the character shown in the attached reference image" rather than re-describing their physical appearance from scratch. You may add action, pose, and expression details, but do NOT re-invent their face, hair, clothing, or build.
- The image generation model will receive the actual character reference images. Your job is to describe the scene, composition, and action — not to re-describe the character's appearance.

Pipeline state rules:
- A "== Pipeline State (authoritative) ==" block is appended to each message. It shows the current state of all characters AND all keyframes.
- Do NOT generate characters already marked "ready" unless the user explicitly asks for a regeneration.
- Do NOT generate keyframes already marked "ready" unless the user explicitly asks for a regeneration.
- When creating a NEW character, omit the "id" parameter from the tool call.
- When REGENERATING an existing character, pass the "id" of the character to replace. This creates a new version.
- Use the "groupKey" shown in the state block to reference characters.

General rules:
- Generate characters BEFORE keyframes so references are available.
- Be specific and visual in your prompts. Avoid vague language.
- Each keyframe prompt should be self-contained — include all visual details for the environment, lighting, composition, and action.
- Do NOT skip any scenes — every scene needs both a start and end keyframe.
- Call one tool at a time. Wait for the result before calling the next.
- IMPORTANT: Do NOT call generate_keyframe until the user has reviewed the characters and explicitly approved them.
- IMPORTANT: Only generate assets for the US / English locale. Ignore other locales for now.

Video generation:
- After ALL keyframes (start + end for every scene) are generated and ready, ask the user if they want to proceed with video generation.
- Only call generate_videos when the user explicitly confirms they want to generate videos.
- generate_videos will create a video clip for each scene by interpolating between the start and end keyframes, guided by the scene's action description and camera movement.`;

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
            "Detailed visual description for the character reference image. Include age, ethnicity, build, clothing, hairstyle, expression, and pose. MUST specify a frontal/front-facing pose against a plain solid-color or transparent background for compositing into keyframes. No environmental backgrounds.",
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
      "Generate a start or end keyframe image for a specific scene. Reference character images are attached automatically when characterIds are provided — describe the scene and action, not the character's appearance.",
    parameters: {
      type: "object",
      properties: {
        beatIndex: {
          type: "number",
          description: "Scene index (0-based) from the approved scene list",
        },
        keyframeType: {
          type: "string",
          enum: ["start", "end"],
          description: "Whether this is the start or end keyframe for the scene",
        },
        label: {
          type: "string",
          description: "Label in the format scene_[N]_start or scene_[N]_end",
        },
        visualPrompt: {
          type: "string",
          description:
            "Detailed visual prompt for the scene. Include camera angle, lighting, composition, setting, and action. Refer to characters as 'the character shown in the attached reference image' — do not re-describe their appearance. Be cinematic and specific.",
        },
        characterIds: {
          type: "array",
          items: { type: "string" },
          description: "Asset IDs of characters in this scene. MANDATORY when the scene includes characters — pass an empty array if no characters are present.",
        },
        includeProductImage: {
          type: "boolean",
          description: "Whether to include the uploaded product image as a reference",
        },
      },
      required: ["beatIndex", "keyframeType", "label", "visualPrompt", "characterIds"],
    },
  },
};

const GENERATE_VIDEOS_TOOL = {
  type: "function" as const,
  function: {
    name: "generate_videos",
    description:
      "Generate video clips for all scenes by interpolating between approved start and end keyframes. Only call this after the user has explicitly confirmed they want to proceed with video generation.",
    parameters: {
      type: "object",
      properties: {},
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
    name: GENERATE_KEYFRAME_TOOL.function.name,
    description: GENERATE_KEYFRAME_TOOL.function.description,
    parameters: GENERATE_KEYFRAME_TOOL.function.parameters as unknown as import("@google/generative-ai").FunctionDeclarationSchema,
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
 * Build a compact pipeline state block showing characters, keyframes, and videos.
 */
export function buildPipelineStateBlock(
  charGroups: Record<string, AssetRow[]>,
  keyframeAssets: AssetRow[],
  sceneCount: number,
  videoAssets?: AssetRow[],
): string {
  const lines: string[] = ["== Pipeline State (authoritative) =="];

  // ── Characters ──
  lines.push("Characters:");
  const charKeys = Object.keys(charGroups);
  if (charKeys.length === 0) {
    lines.push("  (none yet — review the scene list and generate all needed characters)");
  } else {
    for (const gk of charKeys) {
      const versions = charGroups[gk];
      const latest = versions[0];
      if (!latest) continue;
      const name = latest.meta ? (() => { try { return JSON.parse(latest.meta).name; } catch { return gk; } })() : gk;
      const statusStr = formatAssetStatus(latest);
      lines.push(`- [groupKey: "${gk}", id: "${latest.id}", version: ${latest.version}] "${name}" -- ${statusStr}`);
    }
  }

  // ── Keyframes ──
  lines.push("Keyframes:");
  if (sceneCount === 0) {
    lines.push("  (no scenes in brief)");
  } else {
    for (let i = 0; i < sceneCount; i++) {
      const startKf = keyframeAssets.find((a) => {
        if (a.shotIndex !== i) return false;
        try { return a.meta ? JSON.parse(a.meta).keyframeType === "start" : false; } catch { return false; }
      });
      const endKf = keyframeAssets.find((a) => {
        if (a.shotIndex !== i) return false;
        try { return a.meta ? JSON.parse(a.meta).keyframeType === "end" : false; } catch { return false; }
      });
      const startStatus = startKf ? formatAssetStatus(startKf) : "not_generated";
      const endStatus = endKf ? formatAssetStatus(endKf) : "not_generated";
      const startId = startKf ? `, id: "${startKf.id}"` : "";
      const endId = endKf ? `, id: "${endKf.id}"` : "";
      lines.push(`- scene_${i}: start [${startStatus}${startId}] | end [${endStatus}${endId}]`);
    }
  }

  // ── Videos ──
  if (videoAssets && sceneCount > 0) {
    lines.push("Videos:");
    for (let i = 0; i < sceneCount; i++) {
      const vid = videoAssets.find((a) => a.shotIndex === i);
      const status = vid ? formatAssetStatus(vid) : "not_generated";
      const vidId = vid ? `, id: "${vid.id}"` : "";
      lines.push(`- scene_${i}: [${status}${vidId}]`);
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
      yield { type: "tool_call", name: tc.name, args: tc.args };
      const outcome = await executeTool(tc.name, tc.args);
      functionResponses.push({
        functionResponse: { name: tc.name, response: outcome },
      });
    }

    pendingMessage = functionResponses;
  }
}

const UPDATE_DRAFT_BRIEF_TOOL = {
  type: "function" as const,
  function: {
    name: "update_draft_brief",
    description:
      "Merge factual updates into the session draft. When the user states new facts, call with patch_json: a JSON string of a partial brief, e.g. {\"brand\":{\"name\":\"Acme\"}}.",
    parameters: {
      type: "object",
      properties: {
        patch_json: {
          type: "string",
          description: "Stringified JSON object; only keys the user just clarified.",
        },
      },
      required: ["patch_json"],
    },
  },
};

const COMMIT_SCRIPT_VERSION_TOOL = {
  type: "function" as const,
  function: {
    name: "commit_script_version",
    description:
      "Save one approved version to the storyboard. ONLY after the user confirmed BOTH the full scene list (≤5) AND the full cast (≤3).",
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
  draftBriefJson: string,
): AsyncGenerator<StreamEvent> {
  const discoveryInstruction = buildDiscoverySystemPrompt(draftBriefJson);
  const { GoogleGenerativeAI, FunctionCallingMode } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({
    model: GEMINI_TEXT_MODEL,
    systemInstruction: discoveryInstruction,
    tools: [{
      functionDeclarations: [
        {
          name: UPDATE_DRAFT_BRIEF_TOOL.function.name,
          description: UPDATE_DRAFT_BRIEF_TOOL.function.description,
          parameters: UPDATE_DRAFT_BRIEF_TOOL.function.parameters as unknown as import("@google/generative-ai").FunctionDeclarationSchema,
        },
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
          toolCalls.push({ name: call.name, args: (call.args ?? {}) as Record<string, unknown> });
          yield { type: "tool_call", name: call.name, args: (call.args ?? {}) as Record<string, unknown> };
        }
      }
    }

    if (toolCalls.length === 0) break;

    const responses: import("@google/generative-ai").FunctionResponsePart[] = toolCalls.map((tc) => ({
      functionResponse: {
        name: tc.name,
        response: { success: true },
      },
    }));
    pendingMessage = responses;
  }
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

export async function localizeBrief(beatsJson: string): Promise<string> {
  const prompt = LOCALIZATION_PROMPT.replace("{BEATS}", beatsJson);
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({ model: GEMINI_TEXT_MODEL });
  const result = await model.generateContent(prompt);
  return result.response.text();
}
