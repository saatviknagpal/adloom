import { NextResponse } from "next/server";
import { getSelectedSnapshot, getSession, updateSessionBrief } from "@/server/services/session";
import { localizeBrief } from "@/server/services/gemini";

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
    return NextResponse.json({ error: "No snapshots found. Chat until a beat list is generated." }, { status: 400 });
  }

  try {
    const raw = await localizeBrief(snapshot.content);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const briefStr = JSON.stringify(parsed);
    const beatsStr = snapshot.content;

    await updateSessionBrief(id, briefStr, beatsStr);

    return NextResponse.json({ status: "script_approved", brief: parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to localize brief";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
