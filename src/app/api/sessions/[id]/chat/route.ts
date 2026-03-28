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
  buildPipelineStateBlock,
  buildKeyframeContext,
  streamChat,
  streamKeyframeChat,
  type ToolExecutor,
} from "@/server/services/gemini";
import { extractKeyFromUri } from "@/lib/storage";
import { sendImageGenerationJob, sendVideoGenerationJob } from "@/server/services/image-job-enqueue";

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

async function executeKeyframeTool(
  controller: ReadableStreamDefaultController,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  retryCounts: Record<string, number>,
): Promise<Record<string, unknown>> {
  if (name === "generate_character") {
    const charArgs = args as { name: string; visualPrompt: string; id?: string };
    const result = await executeCharacterTool(controller, sessionId, charArgs, retryCounts);
    return { success: result.success, groupKey: result.groupKey };
  }

  if (name === "generate_keyframe") {
    const kfArgs = args as {
      beatIndex: number;
      keyframeType: "start" | "end";
      label: string;
      visualPrompt: string;
      characterIds: string[];
      includeProductImage?: boolean;
    };

    controller.enqueue(sseEncode({
      text: `\n\nGenerating keyframe: ${kfArgs.label} (scene ${kfArgs.beatIndex}, ${kfArgs.keyframeType})...\n`,
    }));

    let pendingKeyframeId: string | null = null;
    try {
      const labeledRefs: { key: string; label: string }[] = [];
      const refKeys: string[] = [];
      if (kfArgs.characterIds?.length) {
        const charAssets = await getAssetsByKind(sessionId, "character");
        for (const charId of kfArgs.characterIds) {
          const match = charAssets.find((a) => a.id === charId);
          if (match?.generationStatus === "ready" && match.uri) {
            const charName = match.meta ? JSON.parse(match.meta).name : "Character";
            labeledRefs.push({ key: extractKeyFromUri(match.uri), label: charName });
          }
        }
      }
      if (kfArgs.includeProductImage) {
        const productAsset = await getProductImage(sessionId);
        if (productAsset?.uri) refKeys.push(extractKeyFromUri(productAsset.uri));
      }

      const allKeyframes = await getAssetsByKind(sessionId, "keyframe");

      if (kfArgs.keyframeType === "end") {
        const startFrame = allKeyframes.find((a) => {
          if (a.shotIndex !== kfArgs.beatIndex || a.generationStatus !== "ready" || !a.uri) return false;
          try { return a.meta ? JSON.parse(a.meta).keyframeType === "start" : false; } catch { return false; }
        });
        if (startFrame?.uri) {
          labeledRefs.push({ key: extractKeyFromUri(startFrame.uri), label: `scene_${kfArgs.beatIndex}_start` });
        }
      }

      if (kfArgs.keyframeType === "start" && kfArgs.beatIndex > 0) {
        const prevEndFrame = allKeyframes.find((a) => {
          if (a.shotIndex !== kfArgs.beatIndex - 1 || a.generationStatus !== "ready" || !a.uri) return false;
          try { return a.meta ? JSON.parse(a.meta).keyframeType === "end" : false; } catch { return false; }
        });
        if (prevEndFrame?.uri) {
          labeledRefs.push({ key: extractKeyFromUri(prevEndFrame.uri), label: `prev_scene_${kfArgs.beatIndex - 1}_end` });
        }
      }

      const asset = await createPendingAsset(sessionId, "keyframe", {
        shotIndex: kfArgs.beatIndex,
        prompt: kfArgs.visualPrompt,
        meta: JSON.stringify({ label: kfArgs.label, keyframeType: kfArgs.keyframeType }),
      });
      pendingKeyframeId = asset.id;

      controller.enqueue(sseEncode({
        keyframe: { id: asset.id, beatIndex: kfArgs.beatIndex, keyframeType: kfArgs.keyframeType, label: kfArgs.label, prompt: kfArgs.visualPrompt, pending: true },
      }));

      await sendImageGenerationJob({
        assetId: asset.id,
        sessionId,
        prompt: kfArgs.visualPrompt,
        referenceKeys: refKeys.length > 0 ? refKeys : undefined,
        labeledRefs: labeledRefs.length > 0 ? labeledRefs : undefined,
      });

      const outcome = await waitForImageAsset(asset.id);
      if (!outcome.ok) {
        controller.enqueue(sseEncode({
          keyframe: { id: asset.id, beatIndex: kfArgs.beatIndex, keyframeType: kfArgs.keyframeType, label: kfArgs.label, prompt: kfArgs.visualPrompt, pending: false, failed: true, error: outcome.error },
        }));
        controller.enqueue(sseEncode({ text: `\nFailed to generate keyframe "${kfArgs.label}": ${outcome.error}\n` }));
        return { success: false, error: outcome.error };
      }

      controller.enqueue(sseEncode({
        keyframe: { id: asset.id, beatIndex: kfArgs.beatIndex, keyframeType: kfArgs.keyframeType, label: kfArgs.label, uri: outcome.uri, prompt: kfArgs.visualPrompt, pending: false },
      }));
      return { success: true, assetId: asset.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Image generation failed";
      if (pendingKeyframeId) {
        try { await failAssetGeneration(pendingKeyframeId, msg); } catch { /* ignore */ }
        controller.enqueue(sseEncode({
          keyframe: { id: pendingKeyframeId, beatIndex: kfArgs.beatIndex, keyframeType: kfArgs.keyframeType, label: kfArgs.label, prompt: kfArgs.visualPrompt, pending: false, failed: true, error: msg },
        }));
      }
      controller.enqueue(sseEncode({ text: `\nFailed to generate keyframe "${kfArgs.label}": ${msg}\n` }));
      return { success: false, error: msg };
    }
  }

  if (name === "generate_videos") {
    controller.enqueue(sseEncode({
      text: "\n\nStarting video generation for all scenes...\n",
    }));

    const session = await getSession(sessionId);
    const scenesPayload =
      session?.beats?.trim() ||
      (session?.brief ? scenesJsonForKeyframes(session.brief) : "");

    let scenes: SceneData[] = [];
    try {
      const parsed = JSON.parse(scenesPayload || "{}") as { scenes?: SceneData[] };
      scenes = parsed.scenes ?? [];
    } catch { /* ignore */ }

    if (scenes.length === 0) {
      controller.enqueue(sseEncode({ text: "\nNo scenes found in the brief.\n" }));
      return { success: false, error: "No scenes found" };
    }

    await generateVideosForScenes(controller, sessionId, scenes);
    return { success: true, scenesProcessed: scenes.length };
  }

  return { success: false, error: `Unknown tool: ${name}` };
}

const VIDEO_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_JOB_POLL_MS = 5_000;

async function waitForVideoAsset(
  assetId: string,
): Promise<{ ok: true; uri: string } | { ok: false; error: string }> {
  const deadline = Date.now() + VIDEO_JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const asset = await getAssetById(assetId);
    if (!asset) return { ok: false, error: "Asset not found" };
    if (asset.generationStatus === "ready" && asset.uri) {
      return { ok: true, uri: asset.uri };
    }
    if (asset.generationStatus === "failed") {
      return { ok: false, error: asset.generationError ?? "Video generation failed" };
    }
    await new Promise((r) => setTimeout(r, VIDEO_JOB_POLL_MS));
  }
  await failAssetGeneration(assetId, "Timed out waiting for video generation");
  return { ok: false, error: "Timed out waiting for video generation" };
}

type SceneData = {
  scene_number: number;
  action_description?: string;
  camera_movement?: string;
  dialogue?: {
    speaker: string;
    line: string;
    delivery_note: string;
  };
};

async function generateVideosForScenes(
  controller: ReadableStreamDefaultController,
  sessionId: string,
  scenes: SceneData[],
) {
  const keyframeAssets = await getAssetsByKind(sessionId, "keyframe");

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    const startKf = keyframeAssets.find((a) => {
      if (a.shotIndex !== i || a.generationStatus !== "ready" || !a.uri) return false;
      try { return a.meta ? JSON.parse(a.meta).keyframeType === "start" : false; } catch { return false; }
    });
    const endKf = keyframeAssets.find((a) => {
      if (a.shotIndex !== i || a.generationStatus !== "ready" || !a.uri) return false;
      try { return a.meta ? JSON.parse(a.meta).keyframeType === "end" : false; } catch { return false; }
    });

    if (!startKf?.uri || !endKf?.uri) {
      controller.enqueue(sseEncode({
        text: `\nSkipping video for scene ${i} — missing keyframes.\n`,
      }));
      continue;
    }

    const promptParts: string[] = [];
    if (scene.action_description) promptParts.push(scene.action_description);
    if (scene.camera_movement) promptParts.push(`Camera: ${scene.camera_movement}`);
    if (scene.dialogue) {
      promptParts.push(`Dialogue — ${scene.dialogue.speaker} says: "${scene.dialogue.line}" (${scene.dialogue.delivery_note})`);
    }
    const prompt = promptParts.join(". ") || `Scene ${scene.scene_number} video`;

    controller.enqueue(sseEncode({
      text: `\n\nGenerating video for scene ${i}...\n`,
    }));

    let pendingVideoId: string | null = null;
    try {
      const asset = await createPendingAsset(sessionId, "video", {
        shotIndex: i,
        prompt,
        meta: JSON.stringify({ sceneNumber: scene.scene_number }),
      });
      pendingVideoId = asset.id;

      controller.enqueue(sseEncode({
        video: { id: asset.id, sceneIndex: i, prompt, pending: true },
      }));

      let lastError = "";
      let succeeded = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            controller.enqueue(sseEncode({
              text: `\nRetrying video for scene ${i} (attempt ${attempt + 1}/${MAX_RETRIES})...\n`,
            }));
            await resetAssetForRetry(asset.id);
            controller.enqueue(sseEncode({
              video: { id: asset.id, sceneIndex: i, prompt, pending: true },
            }));
          }

          await sendVideoGenerationJob({
            assetId: asset.id,
            sessionId,
            prompt,
            startFrameKey: extractKeyFromUri(startKf.uri),
            endFrameKey: extractKeyFromUri(endKf.uri),
          });

          const outcome = await waitForVideoAsset(asset.id);
          if (outcome.ok) {
            controller.enqueue(sseEncode({
              video: { id: asset.id, sceneIndex: i, uri: outcome.uri, pending: false },
            }));
            succeeded = true;
            break;
          }
          lastError = outcome.error;
        } catch (err) {
          lastError = err instanceof Error ? err.message : "Video generation failed";
        }
      }

      if (!succeeded) {
        try { await failAssetGeneration(asset.id, lastError); } catch { /* ignore */ }
        controller.enqueue(sseEncode({
          video: { id: asset.id, sceneIndex: i, pending: false, failed: true, error: lastError },
        }));
        controller.enqueue(sseEncode({ text: `\nFailed to generate video for scene ${i} after ${MAX_RETRIES} attempts: ${lastError}\n` }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Video generation failed";
      if (pendingVideoId) {
        try { await failAssetGeneration(pendingVideoId, msg); } catch { /* ignore */ }
        controller.enqueue(sseEncode({
          video: { id: pendingVideoId, sceneIndex: i, pending: false, failed: true, error: msg },
        }));
      }
      controller.enqueue(sseEncode({ text: `\nFailed to generate video for scene ${i}: ${msg}\n` }));
    }
  }
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

        const retryCounts: Record<string, number> = {};

        const toolExecutor: ToolExecutor = (name, args) =>
          executeKeyframeTool(controller, id, name, args, retryCounts);

        let sceneCount = 0;
        try {
          const parsed = JSON.parse(scenesPayload || "{}") as { scenes?: unknown[] };
          sceneCount = parsed.scenes?.length ?? 0;
        } catch { /* ignore */ }

        const charGroups = await getCharacterGroups(id);
        const keyframeAssets = await getAssetsByKind(id, "keyframe");
        const videoAssets = await getAssetsByKind(id, "video");
        const stateBlock = buildPipelineStateBlock(charGroups, keyframeAssets, sceneCount, videoAssets);

        const history = getGeminiHistory(
          session.messages.map((m) => ({ role: m.role, content: m.content })),
        );

        const messageWithState = contextMessage + "\n\n" + stateBlock;

        let fullResponse = "";
        for await (const event of streamKeyframeChat(history, messageWithState, toolExecutor)) {
          if (event.type === "text") {
            fullResponse += event.text;
            controller.enqueue(sseEncode({ text: event.text }));
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
