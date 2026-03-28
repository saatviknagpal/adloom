"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

// ── Types ──────────────────────────────────────────────────────────────────

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type SceneRow = {
  scene_number: number;
  start_time: number;
  end_time: number;
  visual_description: string;
  camerashot_type: string;
};

type CastRow = {
  role: string;
  description: string;
};

type Snapshot = {
  id: string;
  version: number;
  label: string | null;
  content: string;
  selected: boolean;
  createdAt: string;
};

type CharacterAsset = {
  id: string;
  name: string;
  uri?: string;
  prompt: string;
  groupKey: string;
  version: number;
  selected: boolean;
  pending?: boolean;
  failed?: boolean;
  error?: string;
};

type KeyframeAsset = {
  id: string;
  beatIndex: number;
  label: string;
  uri?: string;
  prompt: string;
  pending?: boolean;
  failed?: boolean;
  error?: string;
};

type StoryboardTab = "script" | "characters" | "keyframes";
type Locale = "US" | "IN" | "CN";

const LOCALES: { key: Locale; label: string; flag: string; color: string }[] = [
  { key: "US", label: "United States", flag: "🇺🇸", color: "#c0c1ff" },
  { key: "IN", label: "India", flag: "🇮🇳", color: "#ffb783" },
  { key: "CN", label: "China", flag: "🇨🇳", color: "#d0bcff" },
];

// ── SSE helper ─────────────────────────────────────────────────────────────

type SSEPayload = {
  text?: string;
  snapshot?: { id: string; version: number; label: string; content: Record<string, unknown> };
  character?: CharacterAsset & { pending?: boolean; failed?: boolean; error?: string };
  keyframe?: KeyframeAsset & { pending?: boolean; failed?: boolean; error?: string };
  status?: string;
  error?: string;
  draftUpdated?: boolean;
  done?: boolean;
};

function parseSSELines(buffer: string): { payloads: SSEPayload[]; remaining: string } {
  const lines = buffer.split("\n\n");
  const remaining = lines.pop() ?? "";
  const payloads: SSEPayload[] = [];
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      payloads.push(JSON.parse(line.slice(6)) as SSEPayload);
    } catch {
      /* skip malformed */
    }
  }
  return { payloads, remaining };
}

// ── Markdown components ────────────────────────────────────────────────────

const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-4 mb-2 last:mb-0 space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-1">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-base font-bold mb-2">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-sm font-bold mb-1.5">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-sm font-semibold mb-1">{children}</h3>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes("language-");
    return isBlock ? (
      <pre className="my-2 overflow-x-auto rounded-xl border border-[#464554]/40 bg-[#060e20] p-3 text-xs">
        <code>{children}</code>
      </pre>
    ) : (
      <code className="rounded-md bg-[#060e20] px-1.5 py-0.5 text-xs text-[#c0c1ff]">{children}</code>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-[#464554] pl-3 my-2 text-[#c7c4d7]">{children}</blockquote>
  ),
  hr: () => <hr className="border-[#464554] my-3" />,
};

// ── Page ───────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string>("chatting");
  const [approving, setApproving] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [characters, setCharacters] = useState<CharacterAsset[]>([]);
  const [keyframes, setKeyframes] = useState<KeyframeAsset[]>([]);
  const [expandedSnap, setExpandedSnap] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "storyboard">("chat");
  const [storyboardTab, setStoryboardTab] = useState<StoryboardTab>("script");
  const [productImage, setProductImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<{ uri: string; label: string } | null>(null);
  const [versionPickerGroup, setVersionPickerGroup] = useState<string | null>(null);
  const [selectedLocales, setSelectedLocales] = useState<Set<Locale>>(new Set(["US", "IN", "CN"]));
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isKeyframePhase = status === "script_approved" || status === "keyframes_review";

  const characterGroups = (() => {
    const groups: Record<string, CharacterAsset[]> = {};
    for (const c of characters) {
      const gk = c.groupKey || c.id;
      if (!groups[gk]) groups[gk] = [];
      groups[gk].push(c);
    }
    for (const gk of Object.keys(groups)) {
      groups[gk].sort((a, b) => b.version - a.version);
    }
    return groups;
  })();

  // ── SSE state updaters ─────────────────────────────────────────────────

  function handleSSEPayload(
    payload: SSEPayload,
    assistantMsgId: string,
  ) {
    if (payload.text) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, content: m.content + payload.text } : m,
        ),
      );
    }

    if (payload.snapshot) {
      setSnapshots((prev) => [
        ...prev,
        {
          id: payload.snapshot!.id,
          version: payload.snapshot!.version,
          label: payload.snapshot!.label,
          content: JSON.stringify(payload.snapshot!.content),
          selected: false,
          createdAt: new Date().toISOString(),
        },
      ]);
    }

    if (payload.character) {
      const c = payload.character;
      setCharacters((prev) => {
        const idx = prev.findIndex((x) => x.id === c.id);
        const prevRow = idx >= 0 ? prev[idx] : undefined;
        const gk = c.groupKey ?? prevRow?.groupKey ?? c.id;
        const ver = c.version ?? prevRow?.version ?? 1;
        const row: CharacterAsset = {
          id: c.id,
          name: c.name,
          prompt: c.prompt ?? prevRow?.prompt ?? "",
          uri: c.uri,
          groupKey: gk,
          version: ver,
          selected: prevRow?.selected ?? true,
          pending: c.pending ?? false,
          failed: c.failed ?? false,
          error: c.error,
        };
        if (idx === -1) return [...prev, row];
        const copy = [...prev];
        copy[idx] = row;
        return copy;
      });
      setStoryboardTab("characters");
    }

    if (payload.keyframe) {
      const k = payload.keyframe;
      setKeyframes((prev) => {
        const idx = prev.findIndex((x) => x.id === k.id);
        const prevRow = idx >= 0 ? prev[idx] : undefined;
        const row: KeyframeAsset = {
          id: k.id,
          beatIndex: k.beatIndex,
          label: k.label,
          prompt: k.prompt ?? prevRow?.prompt ?? "",
          uri: k.uri,
          pending: k.pending ?? false,
          failed: k.failed ?? false,
          error: k.error,
        };
        if (idx === -1) return [...prev, row];
        const copy = [...prev];
        copy[idx] = row;
        return copy;
      });
      setStoryboardTab("keyframes");
    }

    if (payload.status) setStatus(payload.status);

    if (payload.error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: m.content + `\n\nError: ${payload.error}` }
            : m,
        ),
      );
    }
  }

  async function streamSSE(
    res: Response,
    assistantMsgId: string,
  ) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, remaining } = parseSSELines(buffer);
      buffer = remaining;
      for (const p of payloads) handleSSEPayload(p, assistantMsgId);
    }
  }

  // ── Data fetching ──────────────────────────────────────────────────────

  const fetchSnapshots = useCallback(async () => {
    const res = await fetch(`/api/sessions/${id}/snapshots`);
    if (res.ok) setSnapshots(await res.json());
  }, [id]);

  useEffect(() => {
    fetch(`/api/sessions/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.messages) {
          setMessages(
            data.messages
              .filter((m: { role: string; content: string }) => m.role !== "system" && m.content.trim())
              .map((m: { id: string; role: string; content: string }) => ({
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
              })),
          );
        }
        if (data.status) setStatus(data.status);
        if (data.snapshots) setSnapshots(data.snapshots);
        if (data.assets) {
          const chars = data.assets
            .filter((a: { kind: string }) => a.kind === "character")
            .map(
              (a: {
                id: string;
                uri: string | null;
                prompt: string | null;
                meta: string | null;
                groupKey: string | null;
                version: number;
                selected: boolean;
                generationStatus?: string;
                generationError?: string | null;
              }) => {
                let name = "Character";
                try { if (a.meta) name = JSON.parse(a.meta).name; } catch { /* keep default */ }
                return {
                  id: a.id,
                  name,
                  uri: a.uri ?? undefined,
                  prompt: a.prompt ?? "",
                  groupKey: a.groupKey ?? a.id,
                  version: a.version ?? 1,
                  selected: a.selected ?? false,
                  pending: a.generationStatus === "pending",
                  failed: a.generationStatus === "failed",
                  error: a.generationError ?? undefined,
                };
              },
            );
          setCharacters(chars);

          const kfs = data.assets
            .filter((a: { kind: string }) => a.kind === "keyframe")
            .map(
              (a: {
                id: string;
                uri: string | null;
                prompt: string | null;
                meta: string | null;
                shotIndex: number | null;
                generationStatus?: string;
                generationError?: string | null;
              }) => {
                let label = "Keyframe";
                try { if (a.meta) label = JSON.parse(a.meta).label; } catch { /* keep default */ }
                return {
                  id: a.id,
                  beatIndex: a.shotIndex ?? 0,
                  label,
                  uri: a.uri ?? undefined,
                  prompt: a.prompt ?? "",
                  pending: a.generationStatus === "pending",
                  failed: a.generationStatus === "failed",
                  error: a.generationError ?? undefined,
                };
              },
            );
          setKeyframes(kfs);

          const prod = data.assets.find((a: { kind: string }) => a.kind === "product_image");
          if (prod?.uri) setProductImage(prod.uri);
        }
      });
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Auto-resize textarea ───────────────────────────────────────────────

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  // ── Send message ───────────────────────────────────────────────────────

  async function send() {
    if (!input.trim() || streaming) return;
    const text = input.trim();
    setInput("");

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    try {
      const res = await fetch(`/api/sessions/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: "Error: request failed" } : m)),
        );
      } else {
        await streamSSE(res, assistantMsg.id);
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, content: m.content + "\n\nConnection lost." } : m,
        ),
      );
    }
    setStreaming(false);
  }

  // ── Approve & bootstrap ────────────────────────────────────────────────

  const sendBootstrapRef = useRef(false);

  async function handleApprove() {
    setApproving(true);
    try {
      const res = await fetch(`/api/sessions/${id}/approve`, { method: "POST" });
      const data = await res.json();
      if (data.status === "script_approved") {
        setStatus("script_approved");
        setActiveTab("chat");
        sendBootstrapRef.current = true;
      } else if (data.error) {
        alert(`Approval failed: ${data.error}`);
      }
    } catch {
      alert("Network error during approval");
    }
    setApproving(false);
  }

  useEffect(() => {
    if (!sendBootstrapRef.current || status !== "script_approved" || streaming) return;
    sendBootstrapRef.current = false;

    const syntheticInput = "Begin generating character reference images.";
    setInput("");
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: syntheticInput };
    const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    (async () => {
      try {
        const res = await fetch(`/api/sessions/${id}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: syntheticInput }),
        });
        if (!res.ok || !res.body) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: "Error: request failed" } : m)),
          );
        } else {
          await streamSSE(res, assistantMsg.id);
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, content: m.content + "\n\nConnection lost." } : m,
          ),
        );
      }
      setStreaming(false);
    })();
  }, [status, streaming, id]);

  // ── Actions ────────────────────────────────────────────────────────────

  async function handleSelectSnapshot(snapshotId: string) {
    await fetch(`/api/sessions/${id}/snapshots/${snapshotId}/select`, { method: "POST" });
    setSnapshots((prev) => prev.map((s) => ({ ...s, selected: s.id === snapshotId })));
  }

  async function handleSelectCharacterVersion(groupKey: string, assetId: string) {
    await fetch(`/api/sessions/${id}/characters/${encodeURIComponent(groupKey)}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId }),
    });
    setCharacters((prev) =>
      prev.map((c) => (c.groupKey === groupKey ? { ...c, selected: c.id === assetId } : c)),
    );
    setVersionPickerGroup(null);
  }

  async function handleUploadProduct(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/sessions/${id}/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (data.asset) setProductImage(data.asset.uri);
    } catch {
      alert("Upload failed");
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function toggleLocale(locale: Locale) {
    setSelectedLocales((prev) => {
      const next = new Set(prev);
      if (next.has(locale)) {
        if (next.size > 1) next.delete(locale);
      } else {
        next.add(locale);
      }
      return next;
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function parseScriptVersion(content: string) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const scenes = Array.isArray(parsed.scenes) ? (parsed.scenes as SceneRow[]) : [];
      const ch = parsed.characters as { talent_type?: string; cast?: CastRow[] } | undefined;
      return { scenes, characters: { talent_type: ch?.talent_type, cast: Array.isArray(ch?.cast) ? ch.cast : [] } };
    } catch {
      return { scenes: [] as SceneRow[], characters: { cast: [] as CastRow[] } };
    }
  }

  // ── Chat panel ─────────────────────────────────────────────────────────

  const chatPanel = (
    <div className="flex flex-1 flex-col min-h-0 bg-gradient-to-b from-[#0b1326]/80 to-[#0b1326]">
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-6 scrollbar-thin">
        <div className="mx-auto max-w-2xl space-y-5">
          {messages.length === 0 && (
            <div className="animate-fade-in-up mx-auto mt-12 max-w-md rounded-2xl border border-dashed border-[#464554]/50 bg-[#171f33]/60 px-6 py-10 text-center backdrop-blur-sm">
              <div className="mx-auto mb-4 w-12 h-12 rounded-xl bg-[#c0c1ff]/10 flex items-center justify-center">
                <span className="text-[#c0c1ff] text-xl">&#9998;</span>
              </div>
              <p className="text-xs font-medium uppercase tracking-wider text-[#908fa0] mb-2">
                {isKeyframePhase ? "Visual Production" : "Start here"}
              </p>
              <p className="text-sm leading-relaxed text-[#c7c4d7]">
                {isKeyframePhase
                  ? "Your script is approved. Ask for character reference images, keyframes for each scene, or tweaks to a look."
                  : "Describe your brand, product, and ad concept. I'll help you build a brief with scenes and characters for three markets."}
              </p>
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={m.id}
              className={`flex flex-col gap-1 animate-fade-in-up ${m.role === "user" ? "items-end" : "items-start"}`}
              style={{ animationDelay: `${Math.min(i * 0.03, 0.3)}s` }}
            >
              <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-[#908fa0]">
                {m.role === "user" ? "You" : "Adloom"}
              </span>
              <div
                className={`max-w-[min(85%,36rem)] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-md transition-all ${
                  m.role === "user"
                    ? "bg-gradient-to-br from-[#c0c1ff] to-[#8083ff] text-[#0b1326] font-medium whitespace-pre-wrap ring-1 ring-white/20"
                    : "border border-[#464554]/40 bg-[#171f33]/90 text-[#dae2fd] ring-1 ring-white/[0.04]"
                }`}
              >
                {!m.content ? (
                  <span className="inline-flex gap-1.5 py-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#908fa0] [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#908fa0] [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#908fa0]" />
                  </span>
                ) : m.role === "assistant" ? (
                  <ReactMarkdown components={mdComponents}>{m.content}</ReactMarkdown>
                ) : (
                  m.content
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );

  // ── Storyboard: Script tab ─────────────────────────────────────────────

  const scriptTab = (
    <div className="flex-1 overflow-y-auto px-4 py-4 md:px-5 scrollbar-thin space-y-3">
      {snapshots.length === 0 && (
        <div className="animate-fade-in-up mx-auto mt-10 max-w-xs rounded-xl border border-[#464554]/30 bg-[#171f33]/40 px-4 py-8 text-center">
          <div className="mx-auto mb-3 w-10 h-10 rounded-lg bg-[#c0c1ff]/10 flex items-center justify-center">
            <span className="text-[#c0c1ff]">&#128196;</span>
          </div>
          <p className="text-xs text-[#908fa0] leading-relaxed">
            No versions yet. When the assistant saves a script version, it will appear here.
          </p>
        </div>
      )}
      {snapshots.map((snap) => {
        const { scenes, characters: cast } = parseScriptVersion(snap.content);
        const isExpanded = expandedSnap === snap.id;
        return (
          <div
            key={snap.id}
            className={`rounded-xl border p-4 transition-all duration-300 cursor-pointer shadow-sm hover:shadow-md ${
              snap.selected
                ? "border-[#c0c1ff]/50 bg-[#c0c1ff]/[0.06] ring-1 ring-[#c0c1ff]/20"
                : "border-[#464554]/30 bg-[#171f33]/50 hover:border-[#464554]/60 hover:bg-[#171f33]/80"
            }`}
            onClick={() => setExpandedSnap(isExpanded ? null : snap.id)}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[#dae2fd]">v{snap.version}</span>
                {snap.selected && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide bg-gradient-to-r from-[#c0c1ff] to-[#8083ff] text-[#0b1326] px-2 py-0.5 rounded-full">
                    Selected
                  </span>
                )}
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-[#908fa0]">
                {scenes.length} scene{scenes.length !== 1 ? "s" : ""} &middot; {cast.cast.length} cast
              </span>
            </div>
            {snap.label && <p className="text-xs text-[#c7c4d7] mb-1">{snap.label}</p>}
            {!isExpanded && scenes.length > 0 && (
              <p className="text-xs text-[#908fa0] truncate">{scenes[0]?.visual_description}</p>
            )}
            {isExpanded && (
              <div className="mt-3 space-y-3 animate-fade-in-up" style={{ animationDuration: "0.3s" }}>
                <div>
                  <p className="text-[10px] font-medium text-[#908fa0] uppercase mb-1.5">Characters</p>
                  <p className="text-[10px] text-[#464554] mb-1.5">{cast.talent_type ?? "---"}</p>
                  <ul className="space-y-1.5">
                    {cast.cast.map((c, i) => (
                      <li key={i} className="rounded-lg bg-[#222a3d]/80 px-3 py-2 text-xs text-[#c7c4d7]">
                        <span className="text-[#c0c1ff] font-medium">{c.role}</span> &mdash; {c.description}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-[10px] font-medium text-[#908fa0] uppercase mb-1.5">Scenes</p>
                  <div className="space-y-2">
                    {scenes.map((sc, si) => (
                      <div key={`${sc.scene_number}-${si}`} className="rounded-lg bg-[#222a3d]/80 px-3 py-2.5">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[10px] font-medium text-[#c0c1ff]">Scene {sc.scene_number}</span>
                          <span className="text-[10px] text-[#908fa0]">
                            {sc.start_time}s&ndash;{sc.end_time}s &middot; {sc.camerashot_type}
                          </span>
                        </div>
                        <p className="text-xs text-[#c7c4d7] leading-relaxed">{sc.visual_description}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Locale badges */}
                <div>
                  <p className="text-[10px] font-medium text-[#908fa0] uppercase mb-1.5">Target Markets</p>
                  <div className="flex gap-2">
                    {LOCALES.map((l) => (
                      <span
                        key={l.key}
                        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold border"
                        style={{
                          borderColor: `${l.color}40`,
                          background: `${l.color}10`,
                          color: l.color,
                        }}
                      >
                        {l.flag} {l.key}
                      </span>
                    ))}
                  </div>
                </div>

                {!snap.selected && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectSnapshot(snap.id);
                    }}
                    className="w-full rounded-lg bg-gradient-to-r from-[#c0c1ff] to-[#8083ff] py-2.5 text-xs font-semibold text-[#0b1326] shadow-md hover:shadow-lg transition-all hover:scale-[1.01] active:scale-[0.99]"
                  >
                    Use this version
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // ── Storyboard: Characters tab ─────────────────────────────────────────

  const charactersTab = (() => {
    const groupKeys = Object.keys(characterGroups);
    return (
      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-5 scrollbar-thin">
        {groupKeys.length === 0 && (
          <div className="animate-fade-in-up mx-auto mt-10 max-w-xs rounded-xl border border-[#464554]/30 bg-[#171f33]/40 px-4 py-8 text-center">
            <div className="mx-auto mb-3 w-10 h-10 rounded-lg bg-[#d0bcff]/10 flex items-center justify-center">
              <span className="text-[#d0bcff]">&#128100;</span>
            </div>
            <p className="text-xs text-[#908fa0] leading-relaxed">
              No characters yet. Approve your script to start generating reference images.
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          {groupKeys.map((gk) => {
            const versions = characterGroups[gk];
            const display = versions.find((v) => v.selected) ?? versions[0];
            if (!display) return null;
            const totalVersions = versions.length;
            return (
              <div
                key={gk}
                className={`group rounded-xl border border-[#464554]/30 bg-[#171f33]/60 overflow-hidden shadow-sm transition-all duration-300 hover:border-[#464554]/60 hover:shadow-lg hover:scale-[1.02] ${
                  display.uri && !display.failed ? "cursor-pointer" : "cursor-default"
                }`}
                onClick={() => {
                  if (display.uri && !display.failed)
                    setSelectedImage({ uri: display.uri, label: display.name });
                }}
              >
                <div className="aspect-square bg-[#060e20] relative overflow-hidden">
                  {display.pending && (
                    <div className="absolute inset-0 animate-shimmer flex items-center justify-center">
                      <span className="text-[10px] text-[#908fa0] px-2 text-center">Generating&hellip;</span>
                    </div>
                  )}
                  {display.failed && (
                    <div className="absolute inset-0 bg-[#171f33] flex items-center justify-center p-2">
                      <span className="text-[10px] text-[#ffb4ab] text-center leading-snug">
                        {display.error ?? "Failed"}
                      </span>
                    </div>
                  )}
                  {display.uri && !display.pending && !display.failed && (
                    <img
                      src={display.uri}
                      alt={display.name}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  )}
                  {totalVersions > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setVersionPickerGroup(gk);
                      }}
                      className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm text-[10px] text-[#c7c4d7] px-2 py-0.5 rounded-full font-medium hover:bg-black/80 transition"
                    >
                      v{display.version}/{totalVersions}
                    </button>
                  )}
                </div>
                <div className="border-t border-[#464554]/20 p-3">
                  <p className="text-xs font-semibold text-[#dae2fd] truncate">{display.name}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  })();

  // ── Storyboard: Keyframes tab ──────────────────────────────────────────

  const keyframesTab = (
    <div className="flex-1 overflow-y-auto px-4 py-4 md:px-5 scrollbar-thin">
      {keyframes.length === 0 && (
        <div className="animate-fade-in-up mx-auto mt-10 max-w-xs rounded-xl border border-[#464554]/30 bg-[#171f33]/40 px-4 py-8 text-center">
          <div className="mx-auto mb-3 w-10 h-10 rounded-lg bg-[#ffb783]/10 flex items-center justify-center">
            <span className="text-[#ffb783]">&#127916;</span>
          </div>
          <p className="text-xs text-[#908fa0] leading-relaxed">
            No keyframes yet. After characters are ready, ask the assistant to generate scene images.
          </p>
        </div>
      )}
      <div className="space-y-4">
        {keyframes.map((kf) => (
          <div
            key={kf.id}
            className={`rounded-xl border border-[#464554]/30 bg-[#171f33]/60 overflow-hidden shadow-sm transition-all duration-300 hover:border-[#464554]/60 hover:shadow-lg ${
              kf.uri && !kf.failed ? "cursor-pointer group" : "cursor-default"
            }`}
            onClick={() => {
              if (kf.uri && !kf.failed) setSelectedImage({ uri: kf.uri, label: kf.label });
            }}
          >
            <div className="aspect-video bg-[#060e20] relative overflow-hidden">
              {kf.pending && (
                <div className="absolute inset-0 animate-shimmer flex items-center justify-center">
                  <span className="text-[10px] text-[#908fa0] px-2 text-center">Generating&hellip;</span>
                </div>
              )}
              {kf.failed && (
                <div className="absolute inset-0 bg-[#171f33] flex items-center justify-center p-2">
                  <span className="text-[10px] text-[#ffb4ab] text-center leading-snug">
                    {kf.error ?? "Failed"}
                  </span>
                </div>
              )}
              {kf.uri && !kf.pending && !kf.failed && (
                <img
                  src={kf.uri}
                  alt={kf.label}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              )}
            </div>
            <div className="border-t border-[#464554]/20 p-3">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="rounded-md bg-[#c0c1ff]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#c0c1ff]">
                  Scene {kf.beatIndex}
                </span>
                <span className="text-xs font-medium text-[#dae2fd]">{kf.label}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── Storyboard panel ───────────────────────────────────────────────────

  const storyboardPanel = (
    <div className="flex flex-1 flex-col min-h-0 bg-[#0b1326]/50 md:bg-gradient-to-b md:from-[#0b1326] md:to-[#0b1326]/80">
      <div className="shrink-0 px-3 pt-3 pb-2 md:px-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#908fa0]">Storyboard</p>
        <div className="flex gap-1 rounded-xl border border-[#464554]/30 bg-[#171f33]/60 p-1">
          {(["script", "characters", "keyframes"] as StoryboardTab[]).map((tab) => {
            const count =
              tab === "script" ? snapshots.length : tab === "characters" ? characters.length : keyframes.length;
            const active = storyboardTab === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setStoryboardTab(tab)}
                className={`relative flex-1 rounded-lg px-2 py-2 text-center text-[11px] font-semibold transition-all duration-200 ${
                  active
                    ? "bg-[#222a3d] text-[#dae2fd] shadow-sm ring-1 ring-white/5"
                    : "text-[#908fa0] hover:text-[#c7c4d7]"
                }`}
              >
                {tab === "script" ? "Versions" : tab === "characters" ? "Cast" : "Keyframes"}
                {count > 0 && (
                  <span className={`ml-1 tabular-nums ${active ? "text-[#c0c1ff]" : "text-[#464554]"}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Region selector */}
      {isKeyframePhase && (
        <div className="mx-3 mb-2 shrink-0 rounded-xl border border-[#464554]/30 bg-[#171f33]/40 px-3 py-3 md:mx-4">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[#908fa0]">Target Markets</p>
          <div className="flex gap-2">
            {LOCALES.map((l) => {
              const active = selectedLocales.has(l.key);
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => toggleLocale(l.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold transition-all duration-200 border ${
                    active
                      ? "border-current shadow-sm"
                      : "border-[#464554]/30 text-[#908fa0] opacity-50 hover:opacity-70"
                  }`}
                  style={active ? { color: l.color, borderColor: `${l.color}50`, background: `${l.color}10` } : {}}
                >
                  <span>{l.flag}</span>
                  <span>{l.key}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Product image upload */}
      {isKeyframePhase && (
        <div className="mx-3 mb-2 shrink-0 rounded-xl border border-[#464554]/30 bg-[#171f33]/40 px-3 py-3 md:mx-4">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[#908fa0]">Product</p>
          {productImage ? (
            <div className="flex items-center gap-3">
              <img
                src={productImage}
                alt="Product"
                className="h-11 w-11 rounded-lg object-cover ring-1 ring-[#464554]"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-[#c7c4d7]">Image attached</p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-0.5 text-[11px] font-medium text-[#c0c1ff] hover:text-[#8083ff] transition-colors"
                >
                  Replace
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[#464554]/60 py-3 text-xs text-[#908fa0] transition-all hover:border-[#c0c1ff]/40 hover:bg-[#222a3d]/30 hover:text-[#c7c4d7] disabled:opacity-50"
            >
              <span className="text-lg leading-none text-[#464554]">+</span>
              <span>{uploading ? "Uploading..." : "Add product image (optional)"}</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleUploadProduct}
            className="hidden"
          />
        </div>
      )}

      {storyboardTab === "script" && scriptTab}
      {storyboardTab === "characters" && charactersTab}
      {storyboardTab === "keyframes" && keyframesTab}
    </div>
  );

  // ── Lightbox ───────────────────────────────────────────────────────────

  const lightbox = selectedImage && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md animate-fade-in-up"
      style={{ animationDuration: "0.2s" }}
      onClick={() => setSelectedImage(null)}
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-[#464554]/40 bg-[#171f33] shadow-2xl shadow-black/50 ring-1 ring-white/5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#464554]/30 px-4 py-3">
          <span className="truncate text-sm font-medium text-[#dae2fd]">{selectedImage.label}</span>
          <button
            type="button"
            onClick={() => setSelectedImage(null)}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-[#908fa0] transition hover:bg-[#222a3d] hover:text-[#dae2fd]"
          >
            Close
          </button>
        </div>
        <div className="flex max-h-[calc(85vh-3.5rem)] items-center justify-center bg-[#060e20]/50 p-2">
          <img
            src={selectedImage.uri}
            alt={selectedImage.label}
            className="max-h-[min(70vh,720px)] max-w-full object-contain"
          />
        </div>
      </div>
    </div>
  );

  // ── Version picker modal ───────────────────────────────────────────────

  const versionPickerModal = versionPickerGroup && characterGroups[versionPickerGroup] && (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in-up"
      style={{ animationDuration: "0.2s" }}
      onClick={() => setVersionPickerGroup(null)}
    >
      <div
        className="w-full max-w-xl rounded-t-2xl border border-[#464554]/40 bg-[#171f33] p-5 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[#dae2fd]">
            Versions &mdash; {characterGroups[versionPickerGroup][0]?.name}
          </h3>
          <button
            type="button"
            onClick={() => setVersionPickerGroup(null)}
            className="rounded-lg px-2.5 py-1 text-xs font-semibold text-[#908fa0] hover:bg-[#222a3d] hover:text-[#dae2fd] transition"
          >
            Done
          </button>
        </div>
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
          {characterGroups[versionPickerGroup]
            .slice()
            .sort((a, b) => a.version - b.version)
            .map((v) => (
              <button
                key={v.id}
                onClick={() => handleSelectCharacterVersion(versionPickerGroup!, v.id)}
                className={`shrink-0 rounded-xl border overflow-hidden transition-all duration-200 w-28 hover:scale-105 ${
                  v.selected
                    ? "border-[#c0c1ff] ring-2 ring-[#c0c1ff]/40"
                    : "border-[#464554]/40 hover:border-[#464554]"
                }`}
              >
                <div className="aspect-square bg-[#060e20] relative overflow-hidden">
                  {v.uri && !v.failed ? (
                    <img src={v.uri} alt={v.name} className="w-full h-full object-cover" />
                  ) : v.failed ? (
                    <div className="absolute inset-0 bg-[#171f33] flex items-center justify-center">
                      <span className="text-[10px] text-[#ffb4ab]">Failed</span>
                    </div>
                  ) : (
                    <div className="absolute inset-0 animate-shimmer flex items-center justify-center">
                      <span className="text-[10px] text-[#908fa0]">&hellip;</span>
                    </div>
                  )}
                </div>
                <div className="p-1.5 text-center">
                  <span className="text-[10px] font-medium text-[#c7c4d7]">v{v.version}</span>
                  {v.selected && (
                    <span className="ml-1 text-[10px] bg-gradient-to-r from-[#c0c1ff] to-[#8083ff] text-[#0b1326] px-1.5 py-0.5 rounded-full font-semibold">
                      Active
                    </span>
                  )}
                </div>
              </button>
            ))}
        </div>
      </div>
    </div>
  );

  // ── Layout ─────────────────────────────────────────────────────────────

  return (
    <main className="flex h-screen flex-col bg-[#0b1326] text-[#dae2fd]">
      {lightbox}
      {versionPickerModal}

      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#464554]/30 bg-[#0b1326]/90 px-4 py-3 shadow-sm shadow-black/20 backdrop-blur-xl md:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#c0c1ff] to-[#8083ff] text-xs font-bold text-[#0b1326] shadow-lg shadow-[#c0c1ff]/20">
            A
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-[#dae2fd] font-[var(--font-manrope)]">
              Adloom
            </h1>
            <p className="truncate text-[11px] text-[#908fa0]">
              {isKeyframePhase ? "Visual production" : "Discovery"}
            </p>
          </div>

          {/* Locale indicators */}
          <div className="hidden sm:flex items-center gap-1.5 ml-2">
            {LOCALES.map((l) => (
              <span
                key={l.key}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border"
                style={{
                  borderColor: `${l.color}30`,
                  background: `${l.color}08`,
                  color: l.color,
                }}
              >
                {l.flag} {l.key}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Mobile tab switcher */}
          <div className="flex rounded-lg border border-[#464554]/30 bg-[#171f33]/80 p-0.5 md:hidden">
            <button
              type="button"
              onClick={() => setActiveTab("chat")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                activeTab === "chat" ? "bg-[#222a3d] text-white shadow-sm" : "text-[#908fa0]"
              }`}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("storyboard");
                fetchSnapshots();
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                activeTab === "storyboard" ? "bg-[#222a3d] text-white shadow-sm" : "text-[#908fa0]"
              }`}
            >
              Board
            </button>
          </div>

          {status === "chatting" && (
            <button
              type="button"
              onClick={handleApprove}
              disabled={approving || snapshots.length === 0}
              className="shrink-0 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-emerald-950/30 transition-all hover:shadow-lg hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {approving ? "Working..." : "Approve Script"}
            </button>
          )}
        </div>
      </header>

      {/* Main split */}
      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-h-0 flex-col md:w-[58%] md:max-w-none md:border-r md:border-[#464554]/30 w-full ${
            activeTab !== "chat" ? "hidden md:flex" : "flex"
          }`}
        >
          {chatPanel}
        </div>
        <div
          className={`flex min-h-0 flex-col md:w-[42%] w-full ${
            activeTab !== "storyboard" ? "hidden md:flex" : "flex"
          }`}
        >
          {storyboardPanel}
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-[#464554]/30 bg-[#0b1326]/95 px-4 py-4 backdrop-blur-xl md:px-6">
        <div className="mx-auto flex max-w-3xl items-end gap-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isKeyframePhase
                ? "Ask for character refs, keyframes, or changes..."
                : "Describe your ad, answer questions, refine the brief..."
            }
            rows={1}
            className="min-h-[48px] max-h-[160px] flex-1 resize-none rounded-2xl border border-[#464554]/50 bg-[#171f33]/90 px-4 py-3 text-sm leading-relaxed text-[#dae2fd] placeholder-[#908fa0] shadow-inner shadow-black/20 outline-none transition-all focus:border-[#c0c1ff]/50 focus:ring-2 focus:ring-[#c0c1ff]/20"
          />
          <button
            type="button"
            onClick={send}
            disabled={streaming || !input.trim()}
            className="mb-0.5 shrink-0 rounded-2xl bg-gradient-to-br from-[#c0c1ff] to-[#8083ff] px-5 py-3 text-sm font-semibold text-[#0b1326] shadow-lg shadow-[#c0c1ff]/20 transition-all hover:shadow-xl hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {streaming ? "..." : "Send"}
          </button>
        </div>
      </div>
    </main>
  );
}
