import { GoogleGenerativeAI } from "@google/generative-ai";

let _client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (_client) return _client;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  _client = new GoogleGenerativeAI(key);
  return _client;
}

const MODEL_NAME = "gemini-2.0-flash";

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
- Adapt locale differences through setting, language register, and daily-life context — not ethnic shortcuts.`;

export async function* streamChat(
  history: { role: "user" | "model"; parts: { text: string }[] }[],
  userMessage: string,
): AsyncGenerator<string> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: MODEL_NAME, systemInstruction: SYSTEM_PROMPT });

  const chat = model.startChat({ history });
  const result = await chat.sendMessageStream(userMessage);

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

const BRIEF_EXTRACTION_PROMPT = `Analyze the full conversation above. The user has approved the ad concept.

Extract a JSON object with this exact shape (no markdown fencing, pure JSON):
{
  "product": "string",
  "brandName": "string",
  "targetAudience": "string",
  "tone": "string",
  "offer": "string",
  "visualStyle": "string",
  "beats": [
    { "index": 0, "label": "hook", "description": "...", "spokenLine": "...", "durationSec": 3 }
  ],
  "localizedScripts": {
    "US": { "lines": ["English line per beat..."] },
    "IN": { "lines": ["Hindi line per beat..."] },
    "CN": { "lines": ["Mandarin line per beat..."] }
  }
}

Rules:
- beats should have 4-8 entries covering: hook, problem, product reveal, benefit, CTA (at minimum).
- Each beat's spokenLine is the master English version.
- localizedScripts.US.lines should match spokenLine per beat.
- localizedScripts.IN.lines should be natural Hindi (Devanagari script).
- localizedScripts.CN.lines should be natural Mandarin (Simplified Chinese).
- Keep lines short and punchy — these are ad voiceovers, not essays.`;

export async function extractBrief(
  history: { role: "user" | "model"; parts: { text: string }[] }[],
): Promise<string> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: MODEL_NAME, systemInstruction: SYSTEM_PROMPT });

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(BRIEF_EXTRACTION_PROMPT);
  return result.response.text();
}
