"use client";

import { useParams, useRouter } from "next/navigation";
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
  action_description: string;
  start_frame_description: string;
  end_frame_description: string;
  camera_movement: string;
  dialogue?: {
    speaker: string;
    line: string;
    delivery_note: string;
  };
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
  locale?: string;
  selected: boolean;
  pending?: boolean;
  failed?: boolean;
  error?: string;
};

type VideoAsset = {
  id: string;
  sceneIndex: number;
  uri?: string;
  prompt: string;
  locale?: string;
  pending?: boolean;
  failed?: boolean;
  error?: string;
};

type StoryboardTab = "script" | "characters" | "videos";
type Locale = "US" | "IN" | "CN";

type SessionSummary = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  draftBrief: string | null;
  messages: { content: string }[];
  _count: { messages: number };
};

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
  video?: VideoAsset & { pending?: boolean; failed?: boolean; error?: string; locale?: string };
  finalVideo?: { id: string; uri?: string; locale?: string; pending?: boolean };
  status?: string;
  error?: string;
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
  const [videos, setVideos] = useState<VideoAsset[]>([]);
  const [finalVideos, setFinalVideos] = useState<Record<string, string>>({});
  const [finalVideoLoading, setFinalVideoLoading] = useState<Set<string>>(new Set());
  const [videoLocaleFilter, setVideoLocaleFilter] = useState<string>("US");
  const [charLocaleFilter, setCharLocaleFilter] = useState<string>("US");
  const [expandedSnap, setExpandedSnap] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "storyboard">("chat");
  const [storyboardTab, setStoryboardTab] = useState<StoryboardTab>("script");
  const [productImage, setProductImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<{ uri: string; label: string } | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<{ uri: string; label: string } | null>(null);
  const [versionPickerGroup, setVersionPickerGroup] = useState<string | null>(null);
  const [selectedLocales, setSelectedLocales] = useState<Set<Locale>>(new Set(["US", "IN", "CN"]));
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const router = useRouter();
  const [localesConfirmed, setLocalesConfirmed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isProductionPhase = status === "script_approved" || status === "keyframes_review";

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
          locale: c.locale ?? prevRow?.locale ?? "US",
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
      if (c.locale) setCharLocaleFilter(c.locale);
    }

    if (payload.video) {
      const v = payload.video;
      setVideos((prev) => {
        const idx = prev.findIndex((x) => x.id === v.id);
        const prevRow = idx >= 0 ? prev[idx] : undefined;
        const row: VideoAsset = {
          id: v.id,
          sceneIndex: v.sceneIndex,
          prompt: v.prompt ?? prevRow?.prompt ?? "",
          uri: v.uri,
          locale: v.locale ?? prevRow?.locale ?? "US",
          pending: v.pending ?? false,
          failed: v.failed ?? false,
          error: v.error,
        };
        if (idx === -1) return [...prev, row];
        const copy = [...prev];
        copy[idx] = row;
        return copy;
      });
      setStoryboardTab("videos");
      if (v.locale) setVideoLocaleFilter(v.locale);
    }

    if (payload.finalVideo) {
      const locale = payload.finalVideo.locale ?? "US";
      if (payload.finalVideo.pending) {
        setFinalVideoLoading((prev) => new Set(prev).add(locale));
      } else if (payload.finalVideo.uri) {
        setFinalVideos((prev) => ({ ...prev, [locale]: payload.finalVideo!.uri! }));
        setFinalVideoLoading((prev) => {
          const next = new Set(prev);
          next.delete(locale);
          return next;
        });
        setStoryboardTab("videos");
        setVideoLocaleFilter(locale);
      }
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
    if (buffer.trim()) {
      const { payloads } = parseSSELines(buffer + "\n\n");
      for (const p of payloads) handleSSEPayload(p, assistantMsgId);
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantMsgId && !m.content
          ? { ...m, content: "Working on it..." }
          : m,
      ),
    );
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
                region: string | null;
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
                  locale: a.region ?? "US",
                  selected: a.selected ?? false,
                  pending: a.generationStatus === "pending",
                  failed: a.generationStatus === "failed",
                  error: a.generationError ?? undefined,
                };
              },
            );
          setCharacters(chars);

          const vids = data.assets
            .filter((a: { kind: string }) => a.kind === "video")
            .map(
              (a: {
                id: string;
                uri: string | null;
                prompt: string | null;
                meta: string | null;
                shotIndex: number | null;
                region: string | null;
                generationStatus?: string;
                generationError?: string | null;
              }) => ({
                id: a.id,
                sceneIndex: a.shotIndex ?? 0,
                uri: a.uri ?? undefined,
                prompt: a.prompt ?? "",
                locale: a.region ?? "US",
                pending: a.generationStatus === "pending",
                failed: a.generationStatus === "failed",
                error: a.generationError ?? undefined,
              }),
            );
          setVideos(vids);

          const finalVids = data.assets.filter((a: { kind: string; generationStatus?: string; uri?: string | null; region?: string | null }) =>
            a.kind === "final_video" && a.generationStatus === "ready" && a.uri
          );
          if (finalVids.length > 0) {
            const map: Record<string, string> = {};
            for (const fv of finalVids) {
              const locale = fv.region ?? "US";
              map[locale] = fv.uri!;
            }
            setFinalVideos(map);
          }

          const prod = data.assets.find((a: { kind: string }) => a.kind === "product_image");
          if (prod?.uri) setProductImage(prod.uri);

          if (chars.length > 0 || vids.length > 0) {
            setLocalesConfirmed(true);
          }
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
        body: JSON.stringify({ message: text, locales: Array.from(selectedLocales) }),
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
        setActiveTab("storyboard");
        setStoryboardTab("characters");
        setLocalesConfirmed(false);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "Script approved! Select your target markets in the storyboard panel and hit **Start Generation** to begin.",
          },
        ]);
      } else if (data.error) {
        alert(`Approval failed: ${data.error}`);
      }
    } catch {
      alert("Network error during approval");
    }
    setApproving(false);
  }

  function handleConfirmLocalesAndStart() {
    setLocalesConfirmed(true);
    sendBootstrapRef.current = true;
  }

  useEffect(() => {
    if (!sendBootstrapRef.current || status !== "script_approved" || streaming || !localesConfirmed) return;
    sendBootstrapRef.current = false;

    const syntheticInput = "Begin generating character reference images for all selected markets.";
    setInput("");
    setActiveTab("chat");
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: syntheticInput };
    const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    (async () => {
      try {
        const res = await fetch(`/api/sessions/${id}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: syntheticInput, locales: Array.from(selectedLocales) }),
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
  }, [status, streaming, id, selectedLocales, localesConfirmed]);

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

  async function fetchSessions() {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) setSessions(await res.json());
    } catch { /* ignore */ }
    setSessionsLoading(false);
  }

  async function handleClearConversation() {
    if (!confirm("Clear this conversation? All messages, characters, and keyframes will be deleted.")) return;
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      if (res.ok) {
        setMessages([]);
        setSnapshots([]);
        setCharacters([]);
        setKeyframes([]);
        setVideos([]);
        setProductImage(null);
        setStatus("chatting");
        setExpandedSnap(null);
        setStoryboardTab("script");
      }
    } catch {
      alert("Failed to clear conversation");
    }
  }

  async function handleNewSession() {
    const res = await fetch("/api/sessions", { method: "POST" });
    const data = (await res.json()) as { id: string };
    router.push(`/chat/${data.id}`);
  }

  async function handleDeleteSession(sessionId: string) {
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (sessionId === id) {
      await handleNewSession();
    }
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
                {isProductionPhase ? "Visual Production" : "Start here"}
              </p>
              <p className="text-sm leading-relaxed text-[#c7c4d7]">
                {isProductionPhase
                  ? "Your script is approved. Ask for character reference images, generate scene videos, or tweak the look."
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
              <p className="text-xs text-[#908fa0] truncate">{scenes[0]?.action_description}</p>
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
                            {sc.start_time}s&ndash;{sc.end_time}s &middot; {sc.camera_movement}
                          </span>
                        </div>
                        <p className="text-xs text-[#c7c4d7] leading-relaxed mb-1">{sc.action_description}</p>
                        <div className="space-y-0.5">
                          <p className="text-[10px] text-[#908fa0]"><span className="text-[#c7c4d7]">Start:</span> {sc.start_frame_description}</p>
                          <p className="text-[10px] text-[#908fa0]"><span className="text-[#c7c4d7]">End:</span> {sc.end_frame_description}</p>
                        </div>
                        {sc.dialogue && (
                          <div className="mt-1 rounded bg-[#222a3d]/80 px-2 py-1.5">
                            <p className="text-[10px] text-[#908fa0]">
                              <span className="text-[#ffb783] font-medium">{sc.dialogue.speaker}:</span>{" "}
                              <span className="text-[#c7c4d7] italic">&ldquo;{sc.dialogue.line}&rdquo;</span>
                            </p>
                            <p className="text-[10px] text-[#908fa0] mt-0.5">{sc.dialogue.delivery_note}</p>
                          </div>
                        )}
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
    const activeLocales = LOCALES.filter((l) => selectedLocales.has(l.key));
    const filteredCharacters = characters.filter((c) => (c.locale ?? "US") === charLocaleFilter);

    const filteredGroups: Record<string, CharacterAsset[]> = {};
    for (const c of filteredCharacters) {
      const gk = c.groupKey || c.id;
      if (!filteredGroups[gk]) filteredGroups[gk] = [];
      filteredGroups[gk].push(c);
    }
    for (const gk of Object.keys(filteredGroups)) {
      filteredGroups[gk].sort((a, b) => b.version - a.version);
    }

    const groupKeys = Object.keys(filteredGroups);
    return (
      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-5 scrollbar-thin">
        {/* Country tabs */}
        {activeLocales.length > 1 && (
          <div className="flex mb-4 border-b border-[#464554]/30">
            {activeLocales.map((l) => {
              const active = l.key === charLocaleFilter;
              const localeChars = characters.filter((c) => (c.locale ?? "US") === l.key);
              const readyCount = localeChars.filter((c) => c.uri && !c.pending && !c.failed).length;
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => setCharLocaleFilter(l.key)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold transition-all duration-200 border-b-2 -mb-px ${
                    active
                      ? "border-current text-[#dae2fd]"
                      : "border-transparent text-[#908fa0] hover:text-[#c7c4d7]"
                  }`}
                  style={active ? { color: l.color, borderColor: l.color } : {}}
                >
                  <span className="text-sm">{l.flag}</span>
                  <span>{l.label}</span>
                  {readyCount > 0 && (
                    <span className={`ml-0.5 text-[10px] tabular-nums ${active ? "opacity-70" : "opacity-50"}`}>
                      {readyCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

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
            const versions = filteredGroups[gk];
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

  // ── Storyboard: Videos tab ──────────────────────────────────────────────

  const videosTab = (() => {
    const activeLocales = LOCALES.filter((l) => selectedLocales.has(l.key));
    const currentLocale = videoLocaleFilter;
    const filteredVideos = videos.filter((v) => (v.locale ?? "US") === currentLocale);
    const currentFinalUri = finalVideos[currentLocale];
    const currentFinalLoading = finalVideoLoading.has(currentLocale);
    const localeInfo = LOCALES.find((l) => l.key === currentLocale);

    return (
      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-5 scrollbar-thin">
        {/* Country tabs */}
        {activeLocales.length > 1 && (
          <div className="flex mb-4 border-b border-[#464554]/30">
            {activeLocales.map((l) => {
              const active = l.key === currentLocale;
              const hasFinal = !!finalVideos[l.key];
              const isStitching = finalVideoLoading.has(l.key);
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => setVideoLocaleFilter(l.key)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold transition-all duration-200 border-b-2 -mb-px ${
                    active
                      ? "border-current text-[#dae2fd]"
                      : "border-transparent text-[#908fa0] hover:text-[#c7c4d7]"
                  }`}
                  style={active ? { color: l.color, borderColor: l.color } : {}}
                >
                  <span className="text-sm">{l.flag}</span>
                  <span>{l.label}</span>
                  {hasFinal && <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                  {isStitching && !hasFinal && <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
                </button>
              );
            })}
          </div>
        )}

        {filteredVideos.length === 0 && !currentFinalUri && !currentFinalLoading && (
          <div className="animate-fade-in-up mx-auto mt-10 max-w-xs rounded-xl border border-[#464554]/30 bg-[#171f33]/40 px-4 py-8 text-center">
            <div className="mx-auto mb-3 w-10 h-10 rounded-lg bg-[#c0c1ff]/10 flex items-center justify-center">
              <span className="text-[#c0c1ff]">&#127910;</span>
            </div>
            <p className="text-xs text-[#908fa0] leading-relaxed">
              No videos yet. Approve characters and confirm video generation to see them here.
            </p>
          </div>
        )}

        {/* Final stitched video */}
        {(currentFinalUri || currentFinalLoading) && (
          <div className="mb-5 animate-fade-in-up">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[#908fa0] mb-2">
              Final Ad {localeInfo ? `${localeInfo.flag} ${localeInfo.key}` : currentLocale}
            </p>
            <div
              className={`rounded-xl border overflow-hidden shadow-lg transition-all duration-300 ${
                currentFinalUri
                  ? "border-[#c0c1ff]/40 bg-[#171f33]/80 ring-1 ring-[#c0c1ff]/20 cursor-pointer"
                  : "border-[#464554]/30 bg-[#171f33]/60"
              }`}
              onClick={() => {
                if (currentFinalUri) setSelectedVideo({ uri: currentFinalUri, label: `Final Ad (${currentLocale})` });
              }}
            >
              <div className="aspect-video bg-[#060e20] relative overflow-hidden">
                {currentFinalLoading && !currentFinalUri && (
                  <div className="absolute inset-0 animate-shimmer flex items-center justify-center">
                    <span className="text-xs text-[#908fa0] px-3 text-center">Stitching {currentLocale} scenes&hellip;</span>
                  </div>
                )}
                {currentFinalUri && (
                  <video
                    src={currentFinalUri}
                    className="w-full h-full object-cover"
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                )}
              </div>
              <div className="border-t border-[#464554]/20 p-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-[#dae2fd]">Complete Ad ({currentLocale})</span>
                {currentFinalUri && (
                  <a
                    href={currentFinalUri}
                    download={`adloom-final-${currentLocale.toLowerCase()}.mp4`}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded-lg bg-gradient-to-r from-[#c0c1ff] to-[#8083ff] px-3 py-1.5 text-[10px] font-semibold text-[#0b1326] shadow-sm hover:shadow-md transition-all hover:scale-105 active:scale-95"
                  >
                    Download
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {filteredVideos.length > 0 && (
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[#908fa0] mb-2">Scene Clips</p>
        )}
        <div className="space-y-4">
          {filteredVideos.map((vid) => (
            <div
              key={vid.id}
              className={`rounded-xl border border-[#464554]/30 bg-[#171f33]/60 overflow-hidden shadow-sm transition-all duration-300 hover:border-[#464554]/60 hover:shadow-lg ${
                vid.uri && !vid.failed ? "cursor-pointer group" : "cursor-default"
              }`}
              onClick={() => {
                if (vid.uri && !vid.failed) setSelectedVideo({ uri: vid.uri, label: `Scene ${vid.sceneIndex} (${vid.locale ?? "US"})` });
              }}
            >
              <div className="aspect-video bg-[#060e20] relative overflow-hidden">
                {vid.pending && (
                  <div className="absolute inset-0 animate-shimmer flex items-center justify-center">
                    <span className="text-[10px] text-[#908fa0] px-2 text-center">Generating video&hellip;</span>
                  </div>
                )}
                {vid.failed && (
                  <div className="absolute inset-0 bg-[#171f33] flex items-center justify-center p-2">
                    <span className="text-[10px] text-[#ffb4ab] text-center leading-snug">
                      {vid.error ?? "Failed"}
                    </span>
                  </div>
                )}
                {vid.uri && !vid.pending && !vid.failed && (
                  <video
                    src={vid.uri}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                )}
              </div>
              <div className="border-t border-[#464554]/20 p-3">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="rounded-md bg-[#c0c1ff]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#c0c1ff]">
                    Scene {vid.sceneIndex}
                  </span>
                </div>
                <p className="text-[10px] text-[#908fa0] truncate">{vid.prompt}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  })();

  // ── Storyboard panel ───────────────────────────────────────────────────

  const storyboardPanel = (
    <div className="flex flex-1 flex-col min-h-0 bg-[#0b1326]/50 md:bg-gradient-to-b md:from-[#0b1326] md:to-[#0b1326]/80">
      <div className="shrink-0 px-3 pt-3 pb-2 md:px-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#908fa0]">Storyboard</p>
        <div className="flex gap-1 rounded-xl border border-[#464554]/30 bg-[#171f33]/60 p-1">
          {(["script", "characters", "videos"] as StoryboardTab[]).map((tab) => {
            const count =
              tab === "script"
                ? snapshots.length
                : tab === "characters"
                  ? characters.length
                  : videos.length;
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
                {tab === "script" ? "Versions" : tab === "characters" ? "Cast" : "Videos"}
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

      {/* Locale selection step — shown before generation starts */}
      {isProductionPhase && !localesConfirmed && (
        <div className="mx-3 mb-2 shrink-0 rounded-xl border border-[#c0c1ff]/30 bg-[#171f33]/60 px-4 py-4 md:mx-4">
          <p className="mb-1 text-xs font-semibold text-[#dae2fd]">Select Target Markets</p>
          <p className="mb-3 text-[10px] text-[#908fa0] leading-relaxed">
            Characters and videos will be generated for each selected market. You can review per-region results after generation.
          </p>
          <div className="flex gap-2 mb-3">
            {LOCALES.map((l) => {
              const active = selectedLocales.has(l.key);
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => toggleLocale(l.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-[11px] font-semibold transition-all duration-200 border ${
                    active
                      ? "border-current shadow-sm"
                      : "border-[#464554]/30 text-[#908fa0] opacity-50 hover:opacity-70"
                  }`}
                  style={active ? { color: l.color, borderColor: `${l.color}50`, background: `${l.color}10` } : {}}
                >
                  <span className="text-sm">{l.flag}</span>
                  <span>{l.key}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={handleConfirmLocalesAndStart}
            disabled={selectedLocales.size === 0 || streaming}
            className="w-full rounded-lg bg-gradient-to-r from-[#c0c1ff] to-[#8083ff] py-2.5 text-xs font-semibold text-[#0b1326] shadow-md hover:shadow-lg transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Start Generation
          </button>
        </div>
      )}

      {/* Active locale badges — shown after locales are confirmed */}
      {isProductionPhase && localesConfirmed && (
        <div className="mx-3 mb-2 shrink-0 flex gap-1.5 md:mx-4">
          {LOCALES.filter((l) => selectedLocales.has(l.key)).map((l) => (
            <span
              key={l.key}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold border"
              style={{ borderColor: `${l.color}40`, background: `${l.color}10`, color: l.color }}
            >
              {l.flag} {l.key}
            </span>
          ))}
        </div>
      )}

      {/* Product image upload */}
      {isProductionPhase && (
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
      {storyboardTab === "videos" && videosTab}
    </div>
  );

  // ── Lightbox ───────────────────────────────────────────────────────────

  const videoLightbox = selectedVideo && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={() => setSelectedVideo(null)}
    >
      <div
        className="max-w-2xl max-h-[80vh] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        <video
          src={selectedVideo.uri}
          className="max-w-full max-h-[70vh]"
          controls
          autoPlay
          playsInline
        />
        <div className="px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-zinc-300">{selectedVideo.label}</span>
          <button
            onClick={() => setSelectedVideo(null)}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

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
      {videoLightbox}
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
              {isProductionPhase ? "Visual production" : "Discovery"}
            </p>
          </div>

          {/* Locale indicators */}
          <div className="hidden sm:flex items-center gap-1.5 ml-2">
            {LOCALES.filter((l) => selectedLocales.has(l.key)).map((l) => (
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
          {/* History button */}
          <button
            type="button"
            onClick={() => {
              setShowSessions((p) => !p);
              if (!showSessions) fetchSessions();
            }}
            className="shrink-0 rounded-lg border border-[#464554]/30 bg-[#171f33]/80 px-3 py-2 text-xs font-semibold text-[#c7c4d7] transition-all hover:bg-[#222a3d] hover:text-[#dae2fd]"
            title="Previous sessions"
          >
            History
          </button>

          {/* Clear conversation */}
          <button
            type="button"
            onClick={handleClearConversation}
            disabled={streaming || messages.length === 0}
            className="shrink-0 rounded-lg border border-[#464554]/30 bg-[#171f33]/80 px-3 py-2 text-xs font-semibold text-[#c7c4d7] transition-all hover:bg-[#ffb4ab]/10 hover:text-[#ffb4ab] hover:border-[#ffb4ab]/30 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Clear this conversation"
          >
            Clear
          </button>

          {/* New session */}
          <button
            type="button"
            onClick={handleNewSession}
            className="shrink-0 rounded-lg border border-[#c0c1ff]/30 bg-[#c0c1ff]/10 px-3 py-2 text-xs font-semibold text-[#c0c1ff] transition-all hover:bg-[#c0c1ff]/20"
            title="Start new session"
          >
            + New
          </button>

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

      {/* Sessions drawer */}
      {showSessions && (
        <div
          className="absolute top-[57px] right-4 z-40 w-80 max-h-[70vh] overflow-y-auto rounded-xl border border-[#464554]/40 bg-[#171f33] shadow-2xl shadow-black/40 animate-fade-in-up scrollbar-thin"
          style={{ animationDuration: "0.2s" }}
        >
          <div className="sticky top-0 flex items-center justify-between border-b border-[#464554]/30 bg-[#171f33] px-4 py-3">
            <span className="text-xs font-semibold text-[#dae2fd]">Previous Sessions</span>
            <button
              type="button"
              onClick={() => setShowSessions(false)}
              className="text-[10px] font-semibold text-[#908fa0] hover:text-[#dae2fd] transition-colors"
            >
              Close
            </button>
          </div>
          {sessionsLoading && (
            <div className="px-4 py-6 text-center text-xs text-[#908fa0]">Loading...</div>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-[#908fa0]">No sessions found.</div>
          )}
          {!sessionsLoading &&
            sessions.map((s) => {
              const isCurrent = s.id === id;
              let label = "Untitled";
              try {
                if (s.draftBrief) {
                  const b = JSON.parse(s.draftBrief) as {
                    brand?: { name?: string };
                    product?: { name?: string };
                  };
                  const parts = [b.brand?.name, b.product?.name].filter((v) => v && v.trim());
                  if (parts.length) label = parts.join(" — ");
                }
              } catch {
                /* keep default */
              }
              if (label === "Untitled" && s.messages[0]?.content) {
                label =
                  s.messages[0].content.length > 60
                    ? s.messages[0].content.slice(0, 60) + "..."
                    : s.messages[0].content;
              }
              return (
                <div
                  key={s.id}
                  className={`group flex items-center gap-3 border-b border-[#464554]/15 px-4 py-3 transition-all ${
                    isCurrent ? "bg-[#c0c1ff]/[0.06]" : "hover:bg-[#222a3d]/60 cursor-pointer"
                  }`}
                  onClick={() => {
                    if (!isCurrent) {
                      router.push(`/chat/${s.id}`);
                      setShowSessions(false);
                    }
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-xs font-medium text-[#dae2fd] truncate">{label}</p>
                      {isCurrent && (
                        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-[#c0c1ff] bg-[#c0c1ff]/10 px-1.5 py-0.5 rounded">
                          Current
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-[#908fa0]">
                      <span className="capitalize">{s.status.replace(/_/g, " ")}</span>
                      <span>&middot;</span>
                      <span>{s._count.messages} msgs</span>
                      <span>&middot;</span>
                      <span>{new Date(s.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {!isCurrent && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm("Delete this session?")) handleDeleteSession(s.id);
                      }}
                      className="shrink-0 rounded px-1.5 py-1 text-[10px] text-[#908fa0] opacity-0 group-hover:opacity-100 hover:text-[#ffb4ab] hover:bg-[#ffb4ab]/10 transition-all"
                    >
                      Delete
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}

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
              isProductionPhase
                ? "Ask for character refs, scene videos, or changes..."
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
