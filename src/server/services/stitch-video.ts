import { execFile } from "child_process";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { downloadBuffer, uploadBuffer } from "@/lib/storage";

/**
 * Download scene clips from MinIO, concatenate them with ffmpeg, and upload the result.
 *
 * @param clipKeys  MinIO object keys for each scene clip, in order
 * @param sessionId Used to namespace the output object key
 * @returns         The public URI of the stitched video
 */
export async function stitchSceneClips(
  clipKeys: string[],
  sessionId: string,
): Promise<string> {
  if (clipKeys.length === 0) throw new Error("No clips to stitch");
  if (clipKeys.length === 1) {
    const buf = await downloadBuffer(clipKeys[0]);
    const key = `${sessionId}/final-${randomUUID()}.mp4`;
    return uploadBuffer(buf, key, "video/mp4");
  }

  const workDir = await mkdtemp(join(tmpdir(), "adloom-stitch-"));

  try {
    const clipPaths: string[] = [];
    for (let i = 0; i < clipKeys.length; i++) {
      const buf = await downloadBuffer(clipKeys[i]);
      const path = join(workDir, `clip_${i}.mp4`);
      await writeFile(path, buf);
      clipPaths.push(path);
    }

    // Re-encode each clip to uniform format so concat works reliably
    const normalizedPaths: string[] = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const outPath = join(workDir, `norm_${i}.ts`);
      await runFfmpeg([
        "-i", clipPaths[i],
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "-r", "24",
        "-f", "mpegts",
        outPath,
      ]);
      normalizedPaths.push(outPath);
    }

    const outputPath = join(workDir, "final.mp4");
    const concatInput = normalizedPaths.map((p) => p).join("|");
    await runFfmpeg([
      "-i", `concat:${concatInput}`,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath,
    ]);

    const finalBuf = await readFile(outputPath);
    const key = `${sessionId}/final-${randomUUID()}.mp4`;
    return uploadBuffer(finalBuf, key, "video/mp4");
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });
}
