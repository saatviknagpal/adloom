/** Combine video + VO + music + text overlays into final preview. */

export async function assemblePreview(_input: {
  videoUri: string;
  voiceUri?: string;
  musicUri?: string;
}): Promise<{ uri: string }> {
  void _input;
  throw new Error("assemblePreview: not implemented");
}
