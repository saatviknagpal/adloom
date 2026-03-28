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
1. Help the user define their ad concept: product, brand, audience, tone, offer.
2. Build a beat list (hook → problem → product reveal → CTA) as a shared narrative structure.
3. Write spoken lines for each beat that will later be localized to English (US), Hindi (India), Mandarin (China).
4. Keep iterating until the user is satisfied and confirms.

Rules:
- Be concise and direct. No marketing fluff.
- Ask focused questions when info is missing. Don't ask everything at once.
- When you have enough info, proactively suggest a beat list with spoken lines.
- Present beats in a clear numbered format the user can edit.
- When the user says they're happy / confirms / approves, output the final beat list clearly.
- Do NOT generate images or videos. Your job is script and concept only.
- Do NOT make assumptions about religion, politics, caste, or stereotypes.
- Adapt locale differences through setting, language register, and daily-life context — not ethnic shortcuts.
- ALWAYS call the save_beat_list tool when you present a beat list (new or revised).
- Do NOT skip the tool call even if the user didn't explicitly ask for changes — if you're showing beats, save them.`;

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
1. Review the beat list and identify all distinct characters that appear.
2. For each character, call generate_character with a detailed visual description. Be specific about age, appearance, clothing, expression, and pose. These reference images will be used for consistency across keyframes.
3. Once all characters are generated, go through each beat and call generate_keyframe. Reference the character IDs returned from previous tool calls so the keyframe uses those character designs.
4. Write image prompts that are concrete and cinematic — describe camera angle, lighting, composition, setting, and action. Think like an ad director, not a novelist.

Rules:
- Generate characters BEFORE keyframes so references are available.
- Be specific and visual in your prompts. Avoid vague language.
- Each keyframe prompt should be self-contained — include all visual details needed.
- When referencing characters or products, mention them by name in the prompt AND pass their IDs.
- Do NOT skip any beats — every beat needs at least one keyframe.
- Call one tool at a time. Wait for the result before calling the next.
- After all assets are generated, summarize what was created.
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
