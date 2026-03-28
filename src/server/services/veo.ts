/** Video generation — prefer image-to-video when keyframes exist. */

export async function generateVideo(_input: { prompt: string; keyframeUris?: string[] }): Promise<{ uri: string }> {
  void _input;
  throw new Error("generateVideo: not implemented");
}
