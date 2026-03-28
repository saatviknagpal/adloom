import { NextResponse } from "next/server";
import { createAsset, getSession } from "@/server/services/session";
import { mkdir, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

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
  const outDir = path.join(process.cwd(), "public", "uploads", id);
  await mkdir(outDir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(outDir, filename), buffer);

  const uri = `/uploads/${id}/${filename}`;
  const asset = await createAsset(id, "product_image", uri);

  return NextResponse.json({ asset });
}
