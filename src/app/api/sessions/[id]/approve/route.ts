import { NextResponse } from "next/server";
import { logBriefDebug } from "@/server/lib/brief-debug-log";
import { getSelectedSnapshot, getSession, updateSessionBrief } from "@/server/services/session";
import { mergeApprovedBasicBrief, scenesJsonForKeyframes } from "@/server/services/basic-brief";
import { enrichBriefEmptyFields } from "@/server/services/gemini";

type Params = Promise<{ id: string }>;

export async function POST(_req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (session.status !== "chatting") {
    return NextResponse.json({ error: "Session is not in chat phase" }, { status: 400 });
  }

  const snapshot = await getSelectedSnapshot(id);
  if (!snapshot) {
    return NextResponse.json(
      { error: "No script versions yet. Confirm scenes + characters in chat to save a version, then approve." },
      { status: 400 },
    );
  }

  try {
    logBriefDebug("approve: sessionId", id);
    logBriefDebug("approve: draftBrief (raw DB string)", session.draftBrief ?? "(null)");
    logBriefDebug("approve: snapshot", {
      id: snapshot.id,
      version: snapshot.version,
      label: snapshot.label ?? null,
      contentChars: snapshot.content?.length ?? 0,
      content: snapshot.content,
    });

    const mergedStr = mergeApprovedBasicBrief(session.draftBrief, snapshot.content);
    logBriefDebug("approve: mergedStr (draft + snapshot, before enrich)", mergedStr);

    let finalBriefStr = mergedStr;
    try {
      finalBriefStr = await enrichBriefEmptyFields(mergedStr);
    } catch (err) {
      logBriefDebug(
        "approve: enrichBriefEmptyFields failed, using mergedStr only",
        err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      );
    }

    logBriefDebug("approve: finalBriefStr (persisted to session.brief)", finalBriefStr);
    const briefParsed = JSON.parse(finalBriefStr) as Record<string, unknown>;
    const beatsPayload = scenesJsonForKeyframes(finalBriefStr);

    await updateSessionBrief(id, finalBriefStr, beatsPayload);

    return NextResponse.json({
      status: "script_approved",
      brief: briefParsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build brief";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
