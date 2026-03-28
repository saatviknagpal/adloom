import { selectCharacterVersion } from "@/server/services/session";
import { NextResponse } from "next/server";

type Params = Promise<{ id: string; groupKey: string }>;

export async function POST(req: Request, ctx: { params: Params }) {
  const { id, groupKey } = await ctx.params;
  const body = (await req.json()) as { assetId?: string };

  if (!body.assetId) {
    return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  }

  try {
    await selectCharacterVersion(groupKey, id, body.assetId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
