import { NextResponse } from "next/server";
import { getSnapshots } from "@/server/services/session";

type Params = Promise<{ id: string }>;

export async function GET(_req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  const snapshots = await getSnapshots(id);
  return NextResponse.json(snapshots);
}
