import { inngest } from "@/inngest/client";
import { generateImage } from "@/server/services/nano-banana";
import { completeAssetGeneration, failAssetGeneration } from "@/server/services/session";

export const IMAGE_GENERATE_EVENT = "adloom/image.generate";

export type ImageGenerateEventData = {
  assetId: string;
  sessionId: string;
  prompt: string;
  referenceKeys?: string[];
};

function getOriginalEventData(
  failureEvent: { data: { event?: { data?: ImageGenerateEventData } } },
): ImageGenerateEventData | undefined {
  return failureEvent.data.event?.data;
}

export const generateImageJob = inngest.createFunction(
  {
    id: "generate-image",
    name: "Generate image (Nano Banana)",
    retries: 3,
    triggers: [{ event: IMAGE_GENERATE_EVENT }],
    onFailure: async ({ event, error }) => {
      const data = getOriginalEventData(event);
      if (data?.assetId) {
        await failAssetGeneration(data.assetId, error.message ?? "Image generation failed");
      }
    },
  },
  async ({ event, step }) => {
    const { assetId, sessionId, prompt, referenceKeys } = event.data as ImageGenerateEventData;

    const result = await step.run("nano-banana", async () => {
      return generateImage(prompt, sessionId, referenceKeys);
    });

    await step.run("persist", async () => {
      await completeAssetGeneration(assetId, { uri: result.uri });
    });

    return result;
  },
);
