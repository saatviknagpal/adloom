import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "crypto";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { downloadBuffer, uploadBuffer } from "@/lib/storage";

const VEO_MODEL = process.env.VEO_MODEL?.trim() || "veo-3.1-generate-preview";
const VEO_POLL_INTERVAL_MS = 10_000;
const VEO_TIMEOUT_MS = 10 * 60 * 1000;

function getClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey: key });
}

export type GeneratedVideo = {
  filename: string;
  uri: string;
};

/**
 * Generate a video clip using Veo with start/end frame interpolation.
 *
 * @param prompt          Text prompt describing the action and camera movement
 * @param sessionId       Used to namespace the object key in MinIO
 * @param startFrameKey   MinIO object key for the start frame image
 * @param endFrameKey     MinIO object key for the end frame image
 */
export async function generateVideo(
  prompt: string,
  sessionId: string,
  startFrameKey: string,
  endFrameKey: string,
): Promise<GeneratedVideo> {
  const ai = getClient();

  const startBuffer = await downloadBuffer(startFrameKey);
  const endBuffer = await downloadBuffer(endFrameKey);

  const startBase64 = startBuffer.toString("base64");
  const endBase64 = endBuffer.toString("base64");

  let operation = await ai.models.generateVideos({
    model: VEO_MODEL,
    prompt,
    image: { imageBytes: startBase64, mimeType: "image/png" },
    config: {
      lastFrame: { imageBytes: endBase64, mimeType: "image/png" },
    },
  });

  const deadline = Date.now() + VEO_TIMEOUT_MS;
  while (!operation.done) {
    if (Date.now() > deadline) {
      throw new Error("Veo video generation timed out");
    }
    await new Promise((r) => setTimeout(r, VEO_POLL_INTERVAL_MS));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const generated = operation.response?.generatedVideos?.[0];
  if (!generated?.video) {
    throw new Error("Veo returned no video");
  }

  const video = generated.video;

  let videoBytes: Buffer;
  if (video.videoBytes) {
    videoBytes = Buffer.from(video.videoBytes, "base64");
  } else {
    const tmpPath = join(tmpdir(), `veo-${randomUUID()}.mp4`);
    try {
      await ai.files.download({ file: generated, downloadPath: tmpPath });
      videoBytes = await readFile(tmpPath);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  const filename = `${randomUUID()}.mp4`;
  const key = `${sessionId}/${filename}`;
  const uri = await uploadBuffer(videoBytes, key, "video/mp4");

  return { filename, uri };
}
