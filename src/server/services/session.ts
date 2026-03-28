import { prisma } from "@/lib/db";
import type { SessionStatus } from "@/types";

export async function createSession() {
  return prisma.session.create({ data: {} });
}

export async function getSession(id: string) {
  return prisma.session.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } }, assets: true },
  });
}

export async function addMessage(
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string,
  imageUrl?: string,
) {
  return prisma.message.create({
    data: { sessionId, role, content, imageUrl },
  });
}

export async function updateSessionStatus(id: string, status: SessionStatus) {
  return prisma.session.update({ where: { id }, data: { status } });
}

export async function updateSessionBrief(id: string, brief: string, beats: string) {
  return prisma.session.update({
    where: { id },
    data: { brief, beats, status: "script_approved" },
  });
}

export function getGeminiHistory(messages: { role: string; content: string }[]) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));
}
