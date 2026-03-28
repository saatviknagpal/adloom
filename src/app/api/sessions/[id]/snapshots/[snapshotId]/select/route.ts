import { NextResponse } from "next/server";
import { selectSnapshot } from "@/server/services/session";

type Params = Promise<{ id: string; snapshotId: string }>;

export async function POST(_req: Request, ctx: { params: Params }) {
  const { id, snapshotId } = await ctx.params;
  try {
    await selectSnapshot(snapshotId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to select snapshot";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
