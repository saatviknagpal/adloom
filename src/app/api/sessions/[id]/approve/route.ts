import { NextResponse } from "next/server";
import { getSelectedSnapshot, getSession, updateSessionBrief } from "@/server/services/session";
import { generateMasterBrief } from "@/server/services/gemini";

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
      { error: "No snapshots found. Chat until a beat list is generated." },
      { status: 400 },
    );
  }

  try {
    const chatHistory = session.messages
      .map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`)
      .join("\n\n");

    const rawMaster = await generateMasterBrief(chatHistory, snapshot.content);
    const cleaned = rawMaster
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const briefParsed = JSON.parse(cleaned);

    await updateSessionBrief(id, JSON.stringify(briefParsed), snapshot.content);

    return NextResponse.json({
      status: "script_approved",
      brief: briefParsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate brief";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
