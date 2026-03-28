import {
  addMessage,
  createPendingAsset,
  createSnapshot,
  failAssetGeneration,
  getAssetById,
  getAssetsByKind,
  getGeminiHistory,
  getProductImage,
  getSession,
  updateSessionStatus,
} from "@/server/services/session";
import {
  buildKeyframeContext,
  extractBeatsFromText,
  streamChat,
  streamKeyframeChat,
} from "@/server/services/gemini";
import { extractKeyFromUri } from "@/lib/storage";
import { sendImageGenerationJob } from "@/server/services/image-job-enqueue";

type Params = Promise<{ id: string }>;

function looksLikeBeatList(text: string): boolean {
  const numbered = (text.match(/^\s*\d+\.\s+\*?\*?/gm) ?? []).length;
  const hasBeatKeywords = /\b(hook|problem|reveal|cta|beat)\b/i.test(text);
  return numbered >= 3 && hasBeatKeywords;
}

function sseEncode(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

const IMAGE_JOB_TIMEOUT_MS = 4 * 60 * 1000;
const IMAGE_JOB_POLL_MS = 400;

async function waitForImageAsset(
  assetId: string,
): Promise<{ ok: true; uri: string } | { ok: false; error: string }> {
  const deadline = Date.now() + IMAGE_JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const asset = await getAssetById(assetId);
    if (!asset) return { ok: false, error: "Asset not found" };
    if (asset.generationStatus === "ready" && asset.uri) {
      return { ok: true, uri: asset.uri };
    }
    if (asset.generationStatus === "failed") {
      return { ok: false, error: asset.generationError ?? "Image generation failed" };
    }
    await new Promise((r) => setTimeout(r, IMAGE_JOB_POLL_MS));
  }
  await failAssetGeneration(assetId, "Timed out waiting for image generation");
  return { ok: false, error: "Timed out waiting for image generation" };
}

// ── Keyframe generation phase ──────────────────────────────────────────────

async function handleKeyframeChat(
  id: string,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  userMessage: string,
) {
  const history = getGeminiHistory(
    session.messages.map((m) => ({ role: m.role, content: m.content })),
  );

  const isFirstKeyframeMessage = !session.messages.some(
    (m) => m.role === "system" && m.content.includes("approved brief"),
  );

  let contextMessage = userMessage;
  if (isFirstKeyframeMessage && session.brief && session.beats) {
    contextMessage = buildKeyframeContext(session.brief, session.beats);
    await addMessage(id, "system", contextMessage);
  }

  await addMessage(id, "user", userMessage);

  let fullResponse = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (session.status === "script_approved") {
          await updateSessionStatus(id, "keyframes_review");
          controller.enqueue(sseEncode({ status: "keyframes_review" }));
        }

        for await (const event of streamKeyframeChat(history, contextMessage)) {
          if (event.type === "text") {
            fullResponse += event.text;
            controller.enqueue(sseEncode({ text: event.text }));
          }

          if (event.type === "tool_call" && event.name === "generate_character") {
            const args = event.args as {
              name: string;
              visualPrompt: string;
            };

            controller.enqueue(sseEncode({
              text: `\n\nGenerating character: ${args.name}...\n`,
            }));

            let pendingCharacterId: string | null = null;
            try {
              const asset = await createPendingAsset(id, "character", {
                prompt: args.visualPrompt,
                meta: JSON.stringify({ name: args.name }),
              });
              pendingCharacterId = asset.id;

              controller.enqueue(sseEncode({
                character: {
                  id: asset.id,
                  name: args.name,
                  prompt: args.visualPrompt,
                  pending: true,
                },
              }));

              await sendImageGenerationJob({
                assetId: asset.id,
                sessionId: id,
                prompt: args.visualPrompt,
              });

              const outcome = await waitForImageAsset(asset.id);
              if (!outcome.ok) {
                controller.enqueue(sseEncode({
                  character: {
                    id: asset.id,
                    name: args.name,
                    prompt: args.visualPrompt,
                    pending: false,
                    failed: true,
                    error: outcome.error,
                  },
                }));
                controller.enqueue(sseEncode({
                  text: `\nFailed to generate character "${args.name}": ${outcome.error}\n`,
                }));
                fullResponse += `\n[Character "${args.name}" failed: ${outcome.error}]\n`;
              } else {
                controller.enqueue(sseEncode({
                  character: {
                    id: asset.id,
                    name: args.name,
                    uri: outcome.uri,
                    prompt: args.visualPrompt,
                    pending: false,
                  },
                }));
                fullResponse += `\n[Character "${args.name}" generated: ${outcome.uri}]\n`;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Image generation failed";
              if (pendingCharacterId) {
                try {
                  await failAssetGeneration(pendingCharacterId, msg);
                } catch {
                  /* ignore */
                }
                controller.enqueue(sseEncode({
                  character: {
                    id: pendingCharacterId,
                    name: args.name,
                    prompt: args.visualPrompt,
                    pending: false,
                    failed: true,
                    error: msg,
                  },
                }));
              }
              controller.enqueue(sseEncode({ text: `\nFailed to generate character "${args.name}": ${msg}\n` }));
              fullResponse += `\n[Character "${args.name}" failed: ${msg}]\n`;
            }
          }

          if (event.type === "tool_call" && event.name === "generate_keyframe") {
            const args = event.args as {
              beatIndex: number;
              label: string;
              visualPrompt: string;
              characterIds?: string[];
              includeProductImage?: boolean;
            };

            controller.enqueue(sseEncode({
              text: `\n\nGenerating keyframe: ${args.label} (beat ${args.beatIndex})...\n`,
            }));

            let pendingKeyframeId: string | null = null;
            try {
              const refKeys: string[] = [];

              if (args.characterIds?.length) {
                const charAssets = await getAssetsByKind(id, "character");
                for (const charId of args.characterIds) {
                  const match = charAssets.find((a) => a.id === charId);
                  if (match?.generationStatus === "ready" && match.uri) {
                    refKeys.push(extractKeyFromUri(match.uri));
                  }
                }
              }

              if (args.includeProductImage) {
                const productAsset = await getProductImage(id);
                if (productAsset?.uri) {
                  refKeys.push(extractKeyFromUri(productAsset.uri));
                }
              }

              const asset = await createPendingAsset(id, "keyframe", {
                shotIndex: args.beatIndex,
                prompt: args.visualPrompt,
                meta: JSON.stringify({ label: args.label }),
              });
              pendingKeyframeId = asset.id;

              controller.enqueue(sseEncode({
                keyframe: {
                  id: asset.id,
                  beatIndex: args.beatIndex,
                  label: args.label,
                  prompt: args.visualPrompt,
                  pending: true,
                },
              }));

              await sendImageGenerationJob({
                assetId: asset.id,
                sessionId: id,
                prompt: args.visualPrompt,
                referenceKeys: refKeys.length > 0 ? refKeys : undefined,
              });

              const outcome = await waitForImageAsset(asset.id);
              if (!outcome.ok) {
                controller.enqueue(sseEncode({
                  keyframe: {
                    id: asset.id,
                    beatIndex: args.beatIndex,
                    label: args.label,
                    prompt: args.visualPrompt,
                    pending: false,
                    failed: true,
                    error: outcome.error,
                  },
                }));
                controller.enqueue(sseEncode({
                  text: `\nFailed to generate keyframe "${args.label}": ${outcome.error}\n`,
                }));
                fullResponse += `\n[Keyframe "${args.label}" for beat ${args.beatIndex} failed: ${outcome.error}]\n`;
              } else {
                controller.enqueue(sseEncode({
                  keyframe: {
                    id: asset.id,
                    beatIndex: args.beatIndex,
                    label: args.label,
                    uri: outcome.uri,
                    prompt: args.visualPrompt,
                    pending: false,
                  },
                }));
                fullResponse += `\n[Keyframe "${args.label}" for beat ${args.beatIndex} generated: ${outcome.uri}]\n`;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Image generation failed";
              if (pendingKeyframeId) {
                try {
                  await failAssetGeneration(pendingKeyframeId, msg);
                } catch {
                  /* ignore */
                }
                controller.enqueue(sseEncode({
                  keyframe: {
                    id: pendingKeyframeId,
                    beatIndex: args.beatIndex,
                    label: args.label,
                    prompt: args.visualPrompt,
                    pending: false,
                    failed: true,
                    error: msg,
                  },
                }));
              }
              controller.enqueue(sseEncode({ text: `\nFailed to generate keyframe "${args.label}": ${msg}\n` }));
              fullResponse += `\n[Keyframe "${args.label}" failed: ${msg}]\n`;
            }
          }
        }

        if (fullResponse) {
          await addMessage(id, "assistant", fullResponse);
        }

        controller.enqueue(sseEncode({ done: true }));
        controller.close();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(sseEncode({ error: errMsg }));
        controller.close();
      }
    },
  });

  return stream;
}

// ── Script chat phase ──────────────────────────────────────────────────────

async function handleScriptChat(
  id: string,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  body: { message: string; imageUrl?: string },
) {
  await addMessage(id, "user", body.message, body.imageUrl);

  const history = getGeminiHistory(
    session.messages.map((m) => ({ role: m.role, content: m.content })),
  );

  let fullResponse = "";
  let toolCallFired = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamChat(history, body.message)) {
          if (event.type === "text") {
            fullResponse += event.text;
            controller.enqueue(sseEncode({ text: event.text }));
          }

          if (event.type === "tool_call" && event.name === "save_beat_list") {
            toolCallFired = true;
            let msgId: string | undefined;
            if (fullResponse.trim()) {
              const msg = await addMessage(id, "assistant", fullResponse);
              msgId = msg.id;
              fullResponse = "";
            }
            const snapshot = await createSnapshot(
              id,
              JSON.stringify(event.args),
              msgId,
              (event.args as { label?: string }).label,
            );
            controller.enqueue(sseEncode({
              snapshot: {
                id: snapshot.id,
                version: snapshot.version,
                label: snapshot.label,
                content: event.args,
              },
            }));
          }
        }

        if (fullResponse) {
          const msg = await addMessage(id, "assistant", fullResponse);

          if (!toolCallFired && looksLikeBeatList(fullResponse)) {
            try {
              const extracted = await extractBeatsFromText(fullResponse);
              if (extracted) {
                const parsed = JSON.parse(extracted);
                const snapshot = await createSnapshot(
                  id,
                  extracted,
                  msg.id,
                  parsed.label ?? "Revised draft",
                );
                controller.enqueue(sseEncode({
                  snapshot: {
                    id: snapshot.id,
                    version: snapshot.version,
                    label: snapshot.label,
                    content: parsed,
                  },
                }));
              }
            } catch {
              // fallback extraction failed
            }
          }
        }

        controller.enqueue(sseEncode({ done: true }));
        controller.close();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(sseEncode({ error: errMsg }));
        controller.close();
      }
    },
  });

  return stream;
}

// ── Route handler ──────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export async function POST(req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) return new Response("Session not found", { status: 404 });

  const body = (await req.json()) as { message: string; imageUrl?: string };
  if (!body.message?.trim()) return new Response("Empty message", { status: 400 });

  if (session.status === "chatting") {
    const stream = await handleScriptChat(id, session, body);
    return new Response(stream, { headers: SSE_HEADERS });
  }

  if (session.status === "script_approved" || session.status === "keyframes_review") {
    const stream = await handleKeyframeChat(id, session, body.message);
    return new Response(stream, { headers: SSE_HEADERS });
  }

  return new Response("Session is not in an active phase", { status: 400 });
}
