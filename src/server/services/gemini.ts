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
- Call **commit_script_version** ONLY after explicit confirmation of BOTH the final scene list AND the final character list for this version. Arguments: label (string), scenes (array, 1–5 items), characters ({ talent_type, cast } with 1–3 cast members). Each scene: scene_number, start_time, end_time, visual_description, camerashot_type. Each cast entry: role, description.
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
2. generate_keyframe — create a keyframe (scene image) for a specific scene index (beatIndex), optionally compositing characters and product.

Workflow:
1. Review the beat list and the pipeline state block to see which characters still need generating.
2. For each character not yet marked "ready", call generate_character with a detailed visual description. Be specific about age, appearance, clothing, expression, and pose. Character prompts MUST describe a frontal/front-facing view against a plain solid-color or transparent background with studio-style even lighting. Do NOT include environmental backgrounds — those belong in keyframes, not character references.
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
- Do NOT skip any scenes — every scene needs at least one keyframe.
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
      "Generate a keyframe image for a specific beat in the ad. Optionally reference character and product images for visual consistency.",
    parameters: {
      type: "object",
      properties: {
        beatIndex: {
          type: "number",
          description: "Scene index (0-based) from the approved scene list",
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
export function buildKeyframeContext(brief: string, scenesOrBeatsJson: string): string {
  return `Here is the approved brief and scene list for this ad.

Brief:
${brief}

Scenes (use scene indices 0..n-1 as beatIndex for keyframes):
${scenesOrBeatsJson}

Please begin by identifying the characters needed, generating their reference images, and then creating keyframes for each scene.`;
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
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(getApiKey());
  const model = client.getGenerativeModel({
    model: GEMINI_TEXT_MODEL,
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
              visual_description: { type: "string" },
              camerashot_type: { type: "string" },
            },
            required: ["scene_number", "start_time", "end_time", "visual_description", "camerashot_type"],
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
2. Copy every non-empty string from the input unchanged. For any string that is "" or whitespace-only, write a short, specific value consistent with the rest of the brief (especially scene visual_description, cast role/description, brand/product names).
2b. For creative_direction.theme: if mood is non-empty, the theme must align with that mood (same energy/vibe). Never replace mood with a contradictory theme label.
3. Do not change scene_number, start_time, end_time, camerashot_type, or the structure of scenes[] or characters.cast[] — you may only fill empty strings inside those objects if any exist.
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
