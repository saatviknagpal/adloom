import {
  addMessage,
  createCharacterVersion,
  createPendingAsset,
  createSnapshot,
  failAssetGeneration,
  getAssetById,
  getAssetsByKind,
  getCharacterGroups,
  getGeminiHistory,
  getProductImage,
  getSession,
  mergeSessionDraftBrief,
  resetAssetForRetry,
  updateSessionStatus,
} from "@/server/services/session";
import { scenesJsonForKeyframes, validateScriptVersionPayload } from "@/server/services/basic-brief";
import {
  buildCharacterStateBlock,
  buildKeyframeContext,
  streamChat,
  streamKeyframeChat,
} from "@/server/services/gemini";
import { extractKeyFromUri } from "@/lib/storage";
import { sendImageGenerationJob } from "@/server/services/image-job-enqueue";

type Params = Promise<{ id: string }>;

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

const MAX_STEPS = 20;
const MAX_RETRIES = 3;
const CHARACTER_PROMPT_SUFFIX = " Front-facing view, centered subject, plain solid-color or transparent background, studio lighting. Full body or three-quarter shot suitable for compositing.";

function toGroupKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function executeCharacterTool(
  controller: ReadableStreamDefaultController,
  sessionId: string,
  args: { name: string; visualPrompt: string; id?: string },
  retryCounts: Record<string, number>,
): Promise<{ groupKey: string; success: boolean; responseChunk: string }> {
  const groupKey = toGroupKey(args.name);
  const prompt = args.visualPrompt + CHARACTER_PROMPT_SUFFIX;

  controller.enqueue(sseEncode({
    text: `\n\nGenerating character: ${args.name}...\n`,
  }));

  let asset: { id: string; version: number; groupKey: string | null };
  try {
    if (args.id) {
      const existing = await getAssetById(args.id);
      const gk = existing?.groupKey ?? groupKey;
      asset = await createCharacterVersion(sessionId, gk, prompt, JSON.stringify({ name: args.name }));
    } else {
      const raw = await createPendingAsset(sessionId, "character", {
        prompt,
        meta: JSON.stringify({ name: args.name }),
        groupKey,
        selected: true,
      });
      asset = { id: raw.id, version: raw.version, groupKey: raw.groupKey };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Asset creation failed";
    controller.enqueue(sseEncode({ text: `\nFailed to create asset for "${args.name}": ${msg}\n` }));
    return { groupKey, success: false, responseChunk: "" };
  }

  controller.enqueue(sseEncode({
    character: {
      id: asset.id,
      name: args.name,
      prompt,
      groupKey: asset.groupKey ?? groupKey,
      version: asset.version,
      pending: true,
    },
  }));

  let lastError = "";
  for (let attempt = 0; attempt <= (retryCounts[groupKey] ?? 0); attempt++) {
    try {
      if (attempt > 0) {
        await resetAssetForRetry(asset.id);
      }

      await sendImageGenerationJob({
        assetId: asset.id,
        sessionId,
        prompt,
      });

      const outcome = await waitForImageAsset(asset.id);
      if (outcome.ok) {
        controller.enqueue(sseEncode({
          character: {
            id: asset.id,
            name: args.name,
            uri: outcome.uri,
            prompt,
            groupKey: asset.groupKey ?? groupKey,
            version: asset.version,
            pending: false,
          },
        }));
        return { groupKey, success: true, responseChunk: "" };
      }
      lastError = outcome.error;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Image generation failed";
    }

    if (attempt < MAX_RETRIES - 1) {
      retryCounts[groupKey] = (retryCounts[groupKey] ?? 0) + 1;
    }
  }

  try { await failAssetGeneration(asset.id, lastError); } catch { /* ignore */ }
  controller.enqueue(sseEncode({
    character: {
      id: asset.id,
      name: args.name,
      prompt,
      groupKey: asset.groupKey ?? groupKey,
      version: asset.version,
      pending: false,
      failed: true,
      error: lastError,
    },
  }));
  controller.enqueue(sseEncode({ text: `\nFailed to generate character "${args.name}": ${lastError}\n` }));
  return { groupKey, success: false, responseChunk: "" };
}

async function handleKeyframeChat(
  id: string,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  userMessage: string,
) {
  const isFirstKeyframeMessage = !session.messages.some(
    (m) => m.role === "system" && m.content.includes("approved brief"),
  );

  const scenesPayload =
    session.beats?.trim() ||
    (session.brief ? scenesJsonForKeyframes(session.brief) : "");

  let contextMessage = userMessage;
  if (isFirstKeyframeMessage && session.brief && scenesPayload) {
    contextMessage = buildKeyframeContext(session.brief, scenesPayload);
    await addMessage(id, "system", contextMessage);
  }

  await addMessage(id, "user", userMessage);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (session.status === "script_approved") {
          await updateSessionStatus(id, "keyframes_review");
          controller.enqueue(sseEncode({ status: "keyframes_review" }));
        }

        if (isFirstKeyframeMessage) {
          // ── Agent loop: multi-turn with DB-refreshed state ──
          const retryCounts: Record<string, number> = {};
          let step = 0;

          while (step < MAX_STEPS) {
            const charGroups = await getCharacterGroups(id);
            const stateBlock = buildCharacterStateBlock(charGroups);

            const freshSession = await getSession(id);
            const freshHistory = getGeminiHistory(
              (freshSession?.messages ?? session.messages).map((m) => ({ role: m.role, content: m.content })),
            );

            const messageWithState = contextMessage + "\n\n" + stateBlock;

            let fullResponse = "";
            let hadToolCall = false;

            for await (const event of streamKeyframeChat(freshHistory, messageWithState)) {
              if (event.type === "text") {
                fullResponse += event.text;
                controller.enqueue(sseEncode({ text: event.text }));
              }

              if (event.type === "tool_call" && event.name === "generate_character") {
                hadToolCall = true;
                const charArgs = event.args as { name: string; visualPrompt: string; id?: string };
                await executeCharacterTool(controller, id, charArgs, retryCounts);
              }

              if (event.type === "tool_call" && event.name === "generate_keyframe") {
                hadToolCall = true;
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
                  const labeledRefs: { key: string; label: string }[] = [];
                  const refKeys: string[] = [];
                  if (args.characterIds?.length) {
                    const charAssets = await getAssetsByKind(id, "character");
                    for (const charId of args.characterIds) {
                      const match = charAssets.find((a) => a.id === charId);
                      if (match?.generationStatus === "ready" && match.uri) {
                        const name = match.meta ? JSON.parse(match.meta).name : "Character";
                        labeledRefs.push({ key: extractKeyFromUri(match.uri), label: name });
                      }
                    }
                  }
                  if (args.includeProductImage) {
                    const productAsset = await getProductImage(id);
                    if (productAsset?.uri) refKeys.push(extractKeyFromUri(productAsset.uri));
                  }

                  const asset = await createPendingAsset(id, "keyframe", {
                    shotIndex: args.beatIndex,
                    prompt: args.visualPrompt,
                    meta: JSON.stringify({ label: args.label }),
                  });
                  pendingKeyframeId = asset.id;

                  controller.enqueue(sseEncode({
                    keyframe: { id: asset.id, beatIndex: args.beatIndex, label: args.label, prompt: args.visualPrompt, pending: true },
                  }));

                  await sendImageGenerationJob({
                    assetId: asset.id,
                    sessionId: id,
                    prompt: args.visualPrompt,
                    referenceKeys: refKeys.length > 0 ? refKeys : undefined,
                    labeledRefs: labeledRefs.length > 0 ? labeledRefs : undefined,
                  });

                  const outcome = await waitForImageAsset(asset.id);
                  if (!outcome.ok) {
                    controller.enqueue(sseEncode({
                      keyframe: { id: asset.id, beatIndex: args.beatIndex, label: args.label, prompt: args.visualPrompt, pending: false, failed: true, error: outcome.error },
                    }));
                    controller.enqueue(sseEncode({ text: `\nFailed to generate keyframe "${args.label}": ${outcome.error}\n` }));
                  } else {
                    controller.enqueue(sseEncode({
                      keyframe: { id: asset.id, beatIndex: args.beatIndex, label: args.label, uri: outcome.uri, prompt: args.visualPrompt, pending: false },
                    }));
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "Image generation failed";
                  if (pendingKeyframeId) {
                    try { await failAssetGeneration(pendingKeyframeId, msg); } catch { /* ignore */ }
                    controller.enqueue(sseEncode({
                      keyframe: { id: pendingKeyframeId, beatIndex: args.beatIndex, label: args.label, prompt: args.visualPrompt, pending: false, failed: true, error: msg },
                    }));
                  }
                  controller.enqueue(sseEncode({ text: `\nFailed to generate keyframe "${args.label}": ${msg}\n` }));
                }
              }
            }

            if (fullResponse) {
              await addMessage(id, "assistant", fullResponse);
            }

            if (!hadToolCall) break;
            step++;
          }
        } else {
          // ── Single-turn flow for subsequent messages ──
          const history = getGeminiHistory(
            session.messages.map((m) => ({ role: m.role, content: m.content })),
          );

          let fullResponse = "";
          const retryCounts: Record<string, number> = {};

          for await (const event of streamKeyframeChat(history, contextMessage)) {
            if (event.type === "text") {
              fullResponse += event.text;
              controller.enqueue(sseEncode({ text: event.text }));
            }

            if (event.type === "tool_call" && event.name === "generate_character") {
              const charArgs = event.args as { name: string; visualPrompt: string; id?: string };
              await executeCharacterTool(controller, id, charArgs, retryCounts);
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
                const labeledRefs: { key: string; label: string }[] = [];
                const refKeys: string[] = [];
                if (args.characterIds?.length) {
                  const charAssets = await getAssetsByKind(id, "character");
                  for (const charId of args.characterIds) {
                    const match = charAssets.find((a) => a.id === charId);
                    if (match?.generationStatus === "ready" && match.uri) {
                      const name = match.meta ? JSON.parse(match.meta).name : "Character";
                      labeledRefs.push({ key: extractKeyFromUri(match.uri), label: name });
                    }
                  }
                }
                if (args.includeProductImage) {
                  const productAsset = await getProductImage(id);
                  if (productAsset?.uri) refKeys.push(extractKeyFromUri(productAsset.uri));
                }

                const asset = await createPendingAsset(id, "keyframe", {
                  shotIndex: args.beatIndex,
                  prompt: args.visualPrompt,
                  meta: JSON.stringify({ label: args.label }),
                });
                pendingKeyframeId = asset.id;

                controller.enqueue(sseEncode({
                  keyframe: { id: asset.id, beatIndex: args.beatIndex, label: args.label, prompt: args.visualPrompt, pending: true },
                }));

                await sendImageGenerationJob({
                  assetId: asset.id,
                  sessionId: id,
                  prompt: args.visualPrompt,
                  referenceKeys: refKeys.length > 0 ? refKeys : undefined,
                  labeledRefs: labeledRefs.length > 0 ? labeledRefs : undefined,
                });

                const outcome = await waitForImageAsset(asset.id);
                if (!outcome.ok) {
                  controller.enqueue(sseEncode({
                    keyframe: { id: asset.id, beatIndex: args.beatIndex, label: args.label, prompt: args.visualPrompt, pending: false, failed: true, error: outcome.error },
                  }));
                  controller.enqueue(sseEncode({ text: `\nFailed to generate keyframe "${args.label}": ${outcome.error}\n` }));
                } else {
                  controller.enqueue(sseEncode({
                    keyframe: { id: asset.id, beatIndex: args.beatIndex, label: args.label, uri: outcome.uri, prompt: args.visualPrompt, pending: false },
                  }));
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Image generation failed";
                if (pendingKeyframeId) {
                  try { await failAssetGeneration(pendingKeyframeId, msg); } catch { /* ignore */ }
                  controller.enqueue(sseEncode({
                    keyframe: { id: pendingKeyframeId, beatIndex: args.beatIndex, label: args.label, prompt: args.visualPrompt, pending: false, failed: true, error: msg },
                  }));
                }
                controller.enqueue(sseEncode({ text: `\nFailed to generate keyframe "${args.label}": ${msg}\n` }));
              }
            }
          }

          if (fullResponse) {
            await addMessage(id, "assistant", fullResponse);
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

  const draftJson = session.draftBrief?.trim() ? session.draftBrief : "{}";

  let fullResponse = "";
  /** If the model only emits tools and no text, we still must save a model turn or the next request has two user messages in a row and Gemini can hang. */
  let hadDiscoveryTool = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamChat(history, body.message, draftJson)) {
          if (event.type === "text") {
            fullResponse += event.text;
            controller.enqueue(sseEncode({ text: event.text }));
          }

          if (event.type === "tool_call" && event.name === "update_draft_brief") {
            hadDiscoveryTool = true;
            const raw = (event.args as { patch_json?: string; patch?: Record<string, unknown> }).patch_json;
            let patch: Record<string, unknown> | null = null;
            if (typeof raw === "string" && raw.trim()) {
              try {
                const p = JSON.parse(raw) as unknown;
                if (p && typeof p === "object" && !Array.isArray(p)) patch = p as Record<string, unknown>;
              } catch {
                /* ignore */
              }
            }
            const legacy = (event.args as { patch?: Record<string, unknown> }).patch;
            if (!patch && legacy && typeof legacy === "object") patch = legacy;
            if (patch) {
              await mergeSessionDraftBrief(id, patch);
              controller.enqueue(sseEncode({ draftUpdated: true }));
            }
          }

          if (event.type === "tool_call" && event.name === "commit_script_version") {
            hadDiscoveryTool = true;
            const args = event.args as Record<string, unknown>;
            const err = validateScriptVersionPayload(args);
            if (err) {
              controller.enqueue(sseEncode({ text: `\n\n[Could not save version: ${err}]\n` }));
              continue;
            }
            let msgId: string | undefined;
            if (fullResponse.trim()) {
              const msg = await addMessage(id, "assistant", fullResponse);
              msgId = msg.id;
              fullResponse = "";
            }
            const payload = {
              label: args.label,
              scenes: args.scenes,
              characters: args.characters,
            };
            const snapshot = await createSnapshot(
              id,
              JSON.stringify(payload),
              msgId,
              typeof args.label === "string" ? args.label : undefined,
            );
            controller.enqueue(sseEncode({
              snapshot: {
                id: snapshot.id,
                version: snapshot.version,
                label: snapshot.label,
                content: payload,
              },
            }));

            await mergeSessionDraftBrief(id, {
              characters: payload.characters as Record<string, unknown>,
            });
          }
        }

        const trimmed = fullResponse.trim();
        const assistantContent =
          trimmed || (hadDiscoveryTool ? "(Brief updated.)" : "");
        if (assistantContent) {
          await addMessage(id, "assistant", assistantContent);
        }
        if (hadDiscoveryTool && !trimmed) {
          controller.enqueue(sseEncode({ text: `${assistantContent}\n` }));
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
