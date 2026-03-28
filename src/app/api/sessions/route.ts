import { NextResponse } from "next/server";
import { createSession, listSessions } from "@/server/services/session";

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json(sessions);
}

export async function POST() {
  const session = await createSession();
  return NextResponse.json({ id: session.id, status: session.status });
}
