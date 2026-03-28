import { GoogleGenAI, type VideoGenerationReferenceImage } from "@google/genai";
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
 * Generate a video clip using Veo with optional character/product reference images (up to 3).
 *
 * @param prompt            Text prompt describing the action, camera movement, dialogue
 * @param sessionId         Used to namespace the object key in MinIO
 * @param referenceKeys     MinIO object keys for reference images (character refs, product, etc.) — max 3
 */
export async function generateVideo(
  prompt: string,
  sessionId: string,
  referenceKeys?: string[],
): Promise<GeneratedVideo> {
  const ai = getClient();

  const referenceImages: VideoGenerationReferenceImage[] = [];

  if (referenceKeys?.length) {
    for (const key of referenceKeys.slice(0, 3)) {
      const buf = await downloadBuffer(key);
      referenceImages.push({
        image: { imageBytes: buf.toString("base64"), mimeType: "image/png" },
        referenceType: "ASSET",
      } as VideoGenerationReferenceImage);
    }
  }

  let operation = await ai.models.generateVideos({
    model: VEO_MODEL,
    prompt,
    config: {
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
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

  const opError = (operation as any).error;
  if (opError) {
    const errMsg = typeof opError.message === "string" ? opError.message : JSON.stringify(opError);
    throw new Error(`Veo error (code ${opError.code ?? "unknown"}): ${errMsg}`);
  }

  const generated = operation.response?.generatedVideos?.[0];
  if (!generated?.video) {
    throw new Error("Veo returned no video — response was empty");
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
