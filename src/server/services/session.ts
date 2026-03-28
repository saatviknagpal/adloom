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

export async function createAsset(
  sessionId: string,
  kind: string,
  uri: string,
  opts?: {
    region?: string;
    shotIndex?: number;
    prompt?: string;
    meta?: string;
  },
) {
  return prisma.asset.create({
    data: {
      sessionId,
      kind,
      uri,
      generationStatus: "ready",
      region: opts?.region,
      shotIndex: opts?.shotIndex,
      prompt: opts?.prompt,
      meta: opts?.meta,
    },
  });
}

export async function createPendingAsset(
  sessionId: string,
  kind: string,
  opts?: {
    region?: string;
    shotIndex?: number;
    prompt?: string;
    meta?: string;
    groupKey?: string;
    selected?: boolean;
  },
) {
  return prisma.asset.create({
    data: {
      sessionId,
      kind,
      uri: null,
      generationStatus: "pending",
      region: opts?.region,
      shotIndex: opts?.shotIndex,
      prompt: opts?.prompt,
      meta: opts?.meta,
      groupKey: opts?.groupKey,
      selected: opts?.selected ?? false,
    },
  });
}

export async function getAssetById(assetId: string) {
  return prisma.asset.findUnique({ where: { id: assetId } });
}

export async function completeAssetGeneration(assetId: string, input: { uri: string }) {
  return prisma.asset.update({
    where: { id: assetId },
    data: {
      uri: input.uri,
      generationStatus: "ready",
      generationError: null,
    },
  });
}

export async function failAssetGeneration(assetId: string, message: string) {
  return prisma.asset.update({
    where: { id: assetId },
    data: {
      generationStatus: "failed",
      generationError: message,
    },
  });
}

export async function getAssetsByKind(sessionId: string, kind: string) {
  return prisma.asset.findMany({
    where: { sessionId, kind },
    orderBy: { createdAt: "asc" },
  });
}

export async function getProductImage(sessionId: string) {
  return prisma.asset.findFirst({
    where: { sessionId, kind: "product_image" },
  });
}

// ---------------------------------------------------------------------------
// Character versioning helpers
// ---------------------------------------------------------------------------

export async function getCharacterGroups(sessionId: string) {
  const assets = await prisma.asset.findMany({
    where: { sessionId, kind: "character" },
    orderBy: { version: "desc" },
  });

  const groups: Record<string, typeof assets> = {};
  for (const a of assets) {
    const key = a.groupKey ?? a.id;
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  }
  return groups;
}

export async function createCharacterVersion(
  sessionId: string,
  groupKey: string,
  prompt: string,
  meta?: string,
) {
  const latest = await prisma.asset.findFirst({
    where: { sessionId, kind: "character", groupKey },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  return prisma.asset.create({
    data: {
      sessionId,
      kind: "character",
      uri: null,
      generationStatus: "pending",
      groupKey,
      version: nextVersion,
      prompt,
      meta,
      selected: false,
    },
  });
}

export async function resetAssetForRetry(assetId: string) {
  return prisma.asset.update({
    where: { id: assetId },
    data: {
      generationStatus: "pending",
      generationError: null,
      uri: null,
    },
  });
}

export async function selectCharacterVersion(
  groupKey: string,
  sessionId: string,
  assetId: string,
) {
  await prisma.$transaction([
    prisma.asset.updateMany({
      where: { sessionId, kind: "character", groupKey },
      data: { selected: false },
    }),
    prisma.asset.update({
      where: { id: assetId },
      data: { selected: true },
    }),
  ]);
}

export async function getSelectedCharacters(sessionId: string) {
  const groups = await getCharacterGroups(sessionId);
  const result: Awaited<ReturnType<typeof getAssetById>>[] = [];

  for (const assets of Object.values(groups)) {
    const selected = assets.find((a) => a.selected);
    result.push(selected ?? assets[0] ?? null);
  }
  return result.filter(Boolean);
}
