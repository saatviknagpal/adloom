import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "crypto";
import { downloadBuffer, uploadBuffer } from "@/lib/storage";

const MODEL = "gemini-2.5-flash-image";

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
 * @param referenceKeys   Optional MinIO object keys to include as reference images
 */
export async function generateImage(
  prompt: string,
  sessionId: string,
  referenceKeys?: string[],
): Promise<GeneratedImage> {
  const ai = getClient();

  const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];

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
