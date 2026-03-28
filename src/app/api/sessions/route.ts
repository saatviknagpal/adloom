import { NextResponse } from "next/server";
import { createSession } from "@/server/services/session";

export async function POST() {
  const session = await createSession();
  return NextResponse.json({ id: session.id, status: session.status });
}
