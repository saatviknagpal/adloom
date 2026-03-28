import { NextResponse } from "next/server";
import { createAsset, getSession } from "@/server/services/session";
import { uploadBuffer } from "@/lib/storage";
import { randomUUID } from "crypto";

type Params = Promise<{ id: string }>;

export async function POST(req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
  const filename = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const uri = await uploadBuffer(buffer, `${id}/${filename}`, file.type);
  const asset = await createAsset(id, "product_image", uri);

  return NextResponse.json({ asset });
}
