import { prisma } from "@/lib/db";
import type { SessionStatus } from "@/types";

export async function createSession() {
  return prisma.session.create({ data: {} });
}

export async function getSession(id: string) {
  return prisma.session.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      assets: true,
      snapshots: { orderBy: { version: "asc" } },
    },
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

export async function createSnapshot(
  sessionId: string,
  content: string,
  messageId?: string,
  label?: string,
) {
  const latest = await prisma.snapshot.findFirst({
    where: { sessionId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  return prisma.snapshot.create({
    data: {
      sessionId,
      version: nextVersion,
      label: label ?? `v${nextVersion}`,
      content,
      messageId,
      selected: false,
    },
  });
}

export async function getSnapshots(sessionId: string) {
  return prisma.snapshot.findMany({
    where: { sessionId },
    orderBy: { version: "asc" },
  });
}

export async function selectSnapshot(snapshotId: string, sessionId: string) {
  await prisma.$transaction([
    prisma.snapshot.updateMany({
      where: { sessionId },
      data: { selected: false },
    }),
    prisma.snapshot.update({
      where: { id: snapshotId },
      data: { selected: true },
    }),
  ]);
}

export async function getSelectedSnapshot(sessionId: string) {
  const selected = await prisma.snapshot.findFirst({
    where: { sessionId, selected: true },
  });
  if (selected) return selected;

  return prisma.snapshot.findFirst({
    where: { sessionId },
    orderBy: { version: "desc" },
  });
}
