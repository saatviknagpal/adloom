import { inngest } from "@/inngest/client";
import { generateVideo } from "@/server/services/veo";
import { completeAssetGeneration, failAssetGeneration } from "@/server/services/session";

export const VIDEO_GENERATE_EVENT = "adloom/video.generate";

export type VideoGenerateEventData = {
  assetId: string;
  sessionId: string;
  prompt: string;
  startFrameKey: string;
  endFrameKey: string;
};

function getOriginalEventData(
  failureEvent: { data: { event?: { data?: VideoGenerateEventData } } },
): VideoGenerateEventData | undefined {
  return failureEvent.data.event?.data;
}

export const generateVideoJob = inngest.createFunction(
  {
    id: "generate-video",
    name: "Generate video (Veo)",
    retries: 2,
    triggers: [{ event: VIDEO_GENERATE_EVENT }],
    onFailure: async ({ event, error }) => {
      const data = getOriginalEventData(event);
      if (data?.assetId) {
        await failAssetGeneration(data.assetId, error.message ?? "Video generation failed");
      }
    },
  },
  async ({ event, step }) => {
    const { assetId, sessionId, prompt, startFrameKey, endFrameKey } =
      event.data as VideoGenerateEventData;

    const result = await step.run("veo", async () => {
      return generateVideo(prompt, sessionId, startFrameKey, endFrameKey);
    });

    await step.run("persist", async () => {
      await completeAssetGeneration(assetId, { uri: result.uri });
    });

    return result;
  },
);
