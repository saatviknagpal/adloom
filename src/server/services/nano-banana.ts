import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";

const MODEL = "gemini-2.5-flash-image";

function getClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey: key });
}

export type GeneratedImage = {
  filename: string;
  uri: string; // public path for <img src>
  absPath: string;
};

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

/**
 * Load a local file as a base64-encoded inline data part
 * suitable for Nano Banana reference image input.
 */
export async function fileToInlinePart(filePath: string) {
  const data = await readFile(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return {
    inlineData: {
      mimeType: mime,
      data: data.toString("base64"),
    },
  };
}

/**
 * Generate an image with Nano Banana and save to local filesystem.
 *
 * @param prompt         Text prompt describing the image
 * @param sessionId      Used to namespace the output directory
 * @param referenceImages Optional file paths to include as reference images
 * @returns              Generated image metadata
 */
export async function generateImage(
  prompt: string,
  sessionId: string,
  referenceImages?: string[],
): Promise<GeneratedImage> {
  const ai = getClient();

  const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];

  if (referenceImages?.length) {
    for (const refPath of referenceImages) {
      contents.push(await fileToInlinePart(refPath));
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

  const outDir = path.join(process.cwd(), "public", "uploads", sessionId);
  await ensureDir(outDir);

  const filename = `${randomUUID()}.png`;
  const absPath = path.join(outDir, filename);
  const buffer = Buffer.from(imagePart.inlineData.data as string, "base64");
  await writeFile(absPath, buffer);

  return {
    filename,
    uri: `/uploads/${sessionId}/${filename}`,
    absPath,
  };
}
