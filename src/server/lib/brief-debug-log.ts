const ENABLED = process.env.DEBUG_BRIEF === "1";

export function logBriefDebug(label: string, data?: unknown): void {
  if (!ENABLED) return;
  if (data !== undefined) {
    console.debug(`[brief-debug] ${label}`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  } else {
    console.debug(`[brief-debug] ${label}`);
  }
}
