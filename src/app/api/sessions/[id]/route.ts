import { NextResponse } from "next/server";
import { clearSessionMessages, deleteSession, getSession } from "@/server/services/session";

type Params = Promise<{ id: string }>;

export async function GET(_req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(session);
}

export async function DELETE(_req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  try {
    await deleteSession(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
}

export async function PATCH(req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { action?: string };
  if (body.action === "clear") {
    const session = await clearSessionMessages(id);
    return NextResponse.json({ id: session.id, status: session.status });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
