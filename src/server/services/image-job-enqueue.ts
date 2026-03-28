import { inngest } from "@/inngest/client";
import {
  IMAGE_GENERATE_EVENT,
  type ImageGenerateEventData,
} from "@/inngest/functions/generateImageJob";
import { generateImage } from "@/server/services/nano-banana";
import { completeAssetGeneration } from "@/server/services/session";

const devInlineFallback =
  process.env.NODE_ENV === "development" && process.env.INNGEST_DISABLE_INLINE_FALLBACK !== "1";

/**
 * Enqueue Nano Banana work via Inngest. In local `next dev`, if the Inngest Dev Server
 * is not running (common cause: `fetch failed` to localhost:8288), fall back to in-process
 * generation so the app stays usable. Set INNGEST_DISABLE_INLINE_FALLBACK=1 to force queue-only.
 */
export async function sendImageGenerationJob(data: ImageGenerateEventData): Promise<void> {
  try {
    await inngest.send({ name: IMAGE_GENERATE_EVENT, data });
  } catch (err) {
    if (!devInlineFallback) throw err;
    console.warn(
      "[adloom] Inngest send failed — running image generation in-process. For queued jobs, run: npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest",
      err instanceof Error ? err.message : err,
    );
    const result = await generateImage(data.prompt, data.sessionId, data.referenceKeys, data.labeledRefs);
    await completeAssetGeneration(data.assetId, { uri: result.uri });
  }
}
