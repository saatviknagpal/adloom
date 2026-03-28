import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "crypto";
import { downloadBuffer, uploadBuffer } from "@/lib/storage";

const MODEL = "gemini-3.1-flash-image-preview";

function getClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey: key });
}

export type GeneratedImage = {
  filename: string;
  uri: string;
};

/**
 * Load an image from MinIO as a base64-encoded inline data part
 * suitable for Nano Banana reference image input.
 * @param key MinIO object key (e.g. "sessionId/filename.png")
 */
export async function objectToInlinePart(key: string) {
  const data = await downloadBuffer(key);
  const ext = key.split(".").pop()?.toLowerCase() ?? "png";
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return {
    inlineData: {
      mimeType: mime,
      data: data.toString("base64"),
    },
  };
}

/**
 * Generate an image with Nano Banana and upload to MinIO.
 *
 * @param prompt          Text prompt describing the image
 * @param sessionId       Used to namespace the object key
 * @param referenceKeys   Optional MinIO object keys to include as unlabeled reference images
 * @param labeledRefs     Optional labeled character references (interleaved text label + image)
 */
export async function generateImage(
  prompt: string,
  sessionId: string,
  referenceKeys?: string[],
  labeledRefs?: { key: string; label: string }[],
): Promise<GeneratedImage> {
  const ai = getClient();

  const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];

  if (labeledRefs?.length) {
    const characterRefs = labeledRefs.filter((r) => !r.label.startsWith("scene_"));
    const sceneRefs = labeledRefs.filter((r) => r.label.startsWith("scene_"));

    if (characterRefs.length) {
      contents.push({
        text: "IMPORTANT: The attached reference images show the exact characters to use in this scene. Reproduce their appearance faithfully — same face, hair, clothing, and build. Do not invent new character appearances.",
      });
      for (const ref of characterRefs) {
        contents.push({ text: `Reference image for character '${ref.label}':` });
        contents.push(await objectToInlinePart(ref.key));
      }
    }

    const sameSceneRefs = sceneRefs.filter((r) => !r.label.startsWith("prev_"));
    const crossSceneRefs = sceneRefs.filter((r) => r.label.startsWith("prev_"));

    if (sameSceneRefs.length) {
      contents.push({
        text: "IMPORTANT: The attached scene reference shows the START frame for this scene. Generate an END frame with a clearly different camera angle or shot size (e.g. wide→close-up, over-shoulder→frontal). Maintain the same environment, lighting, and color palette, but make the camera move dramatic — not a subtle zoom.",
      });
      for (const ref of sameSceneRefs) {
        contents.push({ text: `Start frame reference for '${ref.label}':` });
        contents.push(await objectToInlinePart(ref.key));
      }
    }

    if (crossSceneRefs.length) {
      contents.push({
        text: "CONTEXT: The attached image is the end frame of the PREVIOUS scene. Use it to maintain visual continuity across the scene transition — consistent lighting direction, color grade, and spatial relationships. This is a new scene, so the camera angle and composition should change, but the overall look should feel like a continuous sequence.",
      });
      for (const ref of crossSceneRefs) {
        contents.push({ text: `Previous scene end frame for '${ref.label}':` });
        contents.push(await objectToInlinePart(ref.key));
      }
    }
  }

  if (referenceKeys?.length) {
    for (const key of referenceKeys) {
      contents.push(await objectToInlinePart(key));
    }
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("Nano Banana returned no parts");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imagePart = parts.find((p: any) => p.inlineData);
  if (!imagePart?.inlineData?.data) {
    throw new Error("Nano Banana returned no image data");
  }

  const filename = `${randomUUID()}.png`;
  const key = `${sessionId}/${filename}`;
  const buffer = Buffer.from(imagePart.inlineData.data as string, "base64");
  const uri = await uploadBuffer(buffer, key, "image/png");

  return { filename, uri };
}
