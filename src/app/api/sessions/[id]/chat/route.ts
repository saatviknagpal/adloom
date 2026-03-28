import {
  addMessage,
  completeAssetGeneration,
  createCharacterVersion,
  createPendingAsset,
  createSnapshot,
  failAssetGeneration,
  getAssetById,
  getAssetsByKind,
  getAssetsByKindAndRegion,
  getCharacterGroups,
  getGeminiHistory,
  getProductImage,
  getSession,
  resetAssetForRetry,
  updateSessionStatus,
} from "@/server/services/session";
import { scenesJsonForKeyframes, validateScriptVersionPayload } from "@/server/services/basic-brief";
import {
  buildPipelineStateBlock,
  buildKeyframeContext,
  localizeScenes,
  type LocalizationResult,
  streamChat,
  streamKeyframeChat,
  type ToolExecutor,
} from "@/server/services/gemini";
import { extractKeyFromUri } from "@/lib/storage";
import { sendImageGenerationJob, sendVideoGenerationJob } from "@/server/services/image-job-enqueue";
import { stitchSceneClips } from "@/server/services/stitch-video";

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
  args: { name: string; visualPrompt: string; id?: string; locale?: string },
  retryCounts: Record<string, number>,
): Promise<{ groupKey: string; success: boolean; responseChunk: string }> {
  const locale = args.locale ?? "US";
  const baseGroupKey = toGroupKey(args.name);
  const groupKey = locale === "US" ? baseGroupKey : `${baseGroupKey}-${locale.toLowerCase()}`;
  const prompt = args.visualPrompt + CHARACTER_PROMPT_SUFFIX;

  controller.enqueue(sseEncode({
    text: `\n\nGenerating ${locale} character: ${args.name}...\n`,
  }));

  let asset: { id: string; version: number; groupKey: string | null };
  try {
    if (args.id) {
      const existing = await getAssetById(args.id);
      const gk = existing?.groupKey ?? groupKey;
      asset = await createCharacterVersion(sessionId, gk, prompt, JSON.stringify({ name: args.name, locale }));
    } else {
      const raw = await createPendingAsset(sessionId, "character", {
        prompt,
        meta: JSON.stringify({ name: args.name, locale }),
        groupKey,
        region: locale,
        selected: true,
      });
      asset = { id: raw.id, version: raw.version, groupKey: raw.groupKey };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Asset creation failed";
    controller.enqueue(sseEncode({ text: `\nFailed to create asset for "${args.name}" (${locale}): ${msg}\n` }));
    return { groupKey, success: false, responseChunk: "" };
  }

  controller.enqueue(sseEncode({
    character: {
      id: asset.id,
      name: args.name,
      prompt,
      groupKey: asset.groupKey ?? groupKey,
      version: asset.version,
      locale,
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
            locale,
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
      locale,
      pending: false,
      failed: true,
      error: lastError,
    },
  }));
  controller.enqueue(sseEncode({ text: `\nFailed to generate ${locale} character "${args.name}": ${lastError}\n` }));
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
    const charArgs = args as { name: string; visualPrompt: string; id?: string; locale?: string };
    const result = await executeCharacterTool(controller, sessionId, charArgs, retryCounts);
    return { success: result.success, groupKey: result.groupKey, locale: charArgs.locale ?? "US" };
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

    const requestedLocales: string[] = (args.locales as string[] | undefined) ?? ["US"];
    const allLocales = requestedLocales.length > 0 ? requestedLocales : ["US"];

    // Generate US videos first
    const usCharRefKeys = await collectCharacterRefKeys(sessionId, "US");
    controller.enqueue(sseEncode({ text: `\n\n--- Generating US (English) videos ---\n` }));
    const usClipKeys = await generateVideosForScenes(controller, sessionId, scenes, usCharRefKeys, "US");
    await stitchAndEmitFinal(controller, sessionId, usClipKeys, "US");

    // Generate videos for other locales using pre-existing locale characters
    const otherLocales = allLocales.filter((l) => l !== "US");
    if (otherLocales.length > 0 && usClipKeys.length > 0) {
      controller.enqueue(sseEncode({
        text: `\n\nLocalizing dialogue for: ${otherLocales.join(", ")}...\n`,
      }));

      let localized: LocalizationResult = {};
      try {
        localized = await localizeScenes(scenesPayload, otherLocales);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Localization failed";
        controller.enqueue(sseEncode({ text: `\nLocalization failed: ${msg}. Generating with original dialogue.\n` }));
      }

      for (const locale of otherLocales) {
        const localeCharRefKeys = await collectCharacterRefKeys(sessionId, locale);

        controller.enqueue(sseEncode({
          text: `\n\n--- Generating ${locale} videos ---\n`,
        }));
        const overrides = localized[locale] ?? [];
        const localeClipKeys = await generateVideosForScenes(
          controller, sessionId, scenes, localeCharRefKeys, locale, overrides,
        );
        await stitchAndEmitFinal(controller, sessionId, localeClipKeys, locale);
      }
    }

    return { success: true, scenesProcessed: scenes.length, locales: allLocales };
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

/**
 * Collect ready character reference keys for a given region.
 * Falls back to any region if no characters found for the specified one (backward compat).
 */
async function collectCharacterRefKeys(sessionId: string, region: string): Promise<string[]> {
  let charAssets = await getAssetsByKindAndRegion(sessionId, "character", region);
  if (charAssets.length === 0) {
    charAssets = await getAssetsByKind(sessionId, "character");
  }
  return charAssets
    .filter((a) => a.generationStatus === "ready" && a.uri)
    .slice(0, 3)
    .map((a) => extractKeyFromUri(a.uri!));
}


type SceneData = {
  scene_number: number;
  action_description?: string;
  start_frame_description?: string;
  end_frame_description?: string;
  camera_movement?: string;
  dialogue?: {
    speaker: string;
    line: string;
    delivery_note: string;
  };
};

type LocaleDialogueOverride = {
  scene_number: number;
  dialogue: { speaker: string; line: string; delivery_note: string };
};

async function generateVideosForScenes(
  controller: ReadableStreamDefaultController,
  sessionId: string,
  scenes: SceneData[],
  characterRefKeys: string[],
  locale?: string,
  dialogueOverrides?: LocaleDialogueOverride[],
): Promise<string[]> {
  const completedClipKeys: string[] = [];
  const localeLabel = locale ?? "US";

  const productAsset = await getProductImage(sessionId);
  const refKeys = [...characterRefKeys.slice(0, 3)];
  if (productAsset?.uri && refKeys.length < 3) {
    refKeys.push(extractKeyFromUri(productAsset.uri));
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    const localizedDialogue = dialogueOverrides?.find((d) => d.scene_number === scene.scene_number);
    const dialogue = localizedDialogue?.dialogue ?? scene.dialogue;

    const promptParts: string[] = [];
    if (scene.action_description) promptParts.push(scene.action_description);
    if (scene.start_frame_description) promptParts.push(`Opening shot: ${scene.start_frame_description}`);
    if (scene.end_frame_description) promptParts.push(`Ending shot: ${scene.end_frame_description}`);
    if (scene.camera_movement) promptParts.push(`Camera: ${scene.camera_movement}`);
    if (dialogue) {
      promptParts.push(`Dialogue — ${dialogue.speaker} says: "${dialogue.line}" (${dialogue.delivery_note})`);
    }
    const prompt = promptParts.join(". ") || `Scene ${scene.scene_number} video`;

    controller.enqueue(sseEncode({
      text: `\n\nGenerating ${localeLabel} video for scene ${i}...\n`,
    }));

    let pendingVideoId: string | null = null;
    try {
      const asset = await createPendingAsset(sessionId, "video", {
        shotIndex: i,
        prompt,
        region: localeLabel,
        meta: JSON.stringify({ sceneNumber: scene.scene_number, locale: localeLabel }),
      });
      pendingVideoId = asset.id;

      controller.enqueue(sseEncode({
        video: { id: asset.id, sceneIndex: i, prompt, pending: true, locale: localeLabel },
      }));

      let lastError = "";
      let succeeded = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            controller.enqueue(sseEncode({
              text: `\nRetrying ${localeLabel} video for scene ${i} (attempt ${attempt + 1}/${MAX_RETRIES})...\n`,
            }));
            await resetAssetForRetry(asset.id);
            controller.enqueue(sseEncode({
              video: { id: asset.id, sceneIndex: i, prompt, pending: true, locale: localeLabel },
            }));
          }

          await sendVideoGenerationJob({
            assetId: asset.id,
            sessionId,
            prompt,
            referenceKeys: refKeys.length > 0 ? refKeys : undefined,
          });

          const outcome = await waitForVideoAsset(asset.id);
          if (outcome.ok) {
            controller.enqueue(sseEncode({
              video: { id: asset.id, sceneIndex: i, uri: outcome.uri, pending: false, locale: localeLabel },
            }));
            completedClipKeys.push(extractKeyFromUri(outcome.uri));
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
          video: { id: asset.id, sceneIndex: i, pending: false, failed: true, error: lastError, locale: localeLabel },
        }));
        controller.enqueue(sseEncode({ text: `\nFailed to generate ${localeLabel} video for scene ${i} after ${MAX_RETRIES} attempts: ${lastError}\n` }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Video generation failed";
      if (pendingVideoId) {
        try { await failAssetGeneration(pendingVideoId, msg); } catch { /* ignore */ }
        controller.enqueue(sseEncode({
          video: { id: pendingVideoId, sceneIndex: i, pending: false, failed: true, error: msg, locale: localeLabel },
        }));
      }
      controller.enqueue(sseEncode({ text: `\nFailed to generate ${localeLabel} video for scene ${i}: ${msg}\n` }));
    }
  }

  return completedClipKeys;
}

async function stitchAndEmitFinal(
  controller: ReadableStreamDefaultController,
  sessionId: string,
  clipKeys: string[],
  locale: string,
) {
  if (clipKeys.length === 0) return;

  controller.enqueue(sseEncode({
    text: `\n\nStitching ${clipKeys.length} ${locale} scene clips into final video...\n`,
  }));

  try {
    const finalAsset = await createPendingAsset(sessionId, "final_video", {
      region: locale,
      meta: JSON.stringify({ sceneCount: clipKeys.length, locale }),
    });
    controller.enqueue(sseEncode({ finalVideo: { id: finalAsset.id, locale, pending: true } }));

    const finalUri = await stitchSceneClips(clipKeys, sessionId);
    await completeAssetGeneration(finalAsset.id, { uri: finalUri });

    controller.enqueue(sseEncode({
      finalVideo: { id: finalAsset.id, uri: finalUri, locale, pending: false },
    }));
    controller.enqueue(sseEncode({
      text: `\n\n${locale} final video ready!\n`,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stitching failed";
    controller.enqueue(sseEncode({ text: `\nFailed to stitch ${locale} final video: ${msg}\n` }));
  }
}

async function handleKeyframeChat(
  id: string,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  userMessage: string,
  locales?: string[],
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
        const effectiveLocales = locales?.length ? locales : ["US"];

        const toolExecutor: ToolExecutor = (name, args) =>
          executeKeyframeTool(controller, id, name, args, retryCounts);

        let sceneCount = 0;
        try {
          const parsed = JSON.parse(scenesPayload || "{}") as { scenes?: unknown[] };
          sceneCount = parsed.scenes?.length ?? 0;
        } catch { /* ignore */ }

        const charGroups = await getCharacterGroups(id);
        const videoAssets = await getAssetsByKind(id, "video");
        const stateBlock = buildPipelineStateBlock(charGroups, sceneCount, videoAssets, effectiveLocales);

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

  let fullResponse = "";
  let hadTool = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const toolExecutor: ToolExecutor = async (name, args) => {
          if (name === "commit_script_version") {
            hadTool = true;
            const err = validateScriptVersionPayload(args);
            if (err) {
              controller.enqueue(sseEncode({ text: `\n\n[Could not save version: ${err}]\n` }));
              return { success: false, error: err };
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

            return { success: true, version_saved: true, version: snapshot.version };
          }

          return { success: false, error: `Unknown tool: ${name}` };
        };

        for await (const event of streamChat(history, body.message, toolExecutor)) {
          if (event.type === "text") {
            fullResponse += event.text;
            controller.enqueue(sseEncode({ text: event.text }));
          }
        }

        const trimmed = fullResponse.trim();
        if (trimmed) {
          await addMessage(id, "assistant", trimmed);
        } else if (hadTool) {
          const fallback = "Done — your script version is saved to the storyboard! Review it there and approve when ready.";
          await addMessage(id, "assistant", fallback);
          controller.enqueue(sseEncode({ text: fallback }));
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

  const body = (await req.json()) as { message: string; imageUrl?: string; locales?: string[] };
  if (!body.message?.trim()) return new Response("Empty message", { status: 400 });

  if (session.status === "chatting") {
    const stream = await handleScriptChat(id, session, body);
    return new Response(stream, { headers: SSE_HEADERS });
  }

  if (session.status === "script_approved" || session.status === "keyframes_review") {
    const stream = await handleKeyframeChat(id, session, body.message, body.locales);
    return new Response(stream, { headers: SSE_HEADERS });
  }

  return new Response("Session is not in an active phase", { status: 400 });
}
