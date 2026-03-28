"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Beat = {
  index: number;
  label: string;
  description: string;
  spokenLine: string;
  durationSec: number;
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
  const [nextStepsDismissed, setNextStepsDismissed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const fetchSnapshots = useCallback(async () => {
    const res = await fetch(`/api/sessions/${id}/snapshots`);
    if (res.ok) {
      const data = await res.json();
      setSnapshots(data);
    }
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
              }) => ({
                id: a.id,
                name: a.meta ? JSON.parse(a.meta).name : "Character",
                uri: a.uri ?? undefined,
                prompt: a.prompt ?? "",
                groupKey: a.groupKey ?? a.id,
                version: a.version ?? 1,
                selected: a.selected ?? false,
                pending: a.generationStatus === "pending",
                failed: a.generationStatus === "failed",
                error: a.generationError ?? undefined,
              }),
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
              }) => ({
                id: a.id,
                beatIndex: a.shotIndex ?? 0,
                label: a.meta ? JSON.parse(a.meta).label : "Keyframe",
                uri: a.uri ?? undefined,
                prompt: a.prompt ?? "",
                pending: a.generationStatus === "pending",
                failed: a.generationStatus === "failed",
                error: a.generationError ?? undefined,
              }),
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

  async function send() {
    if (!input.trim() || streaming) return;
    const text = input.trim();
    setInput("");

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);
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
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(line.slice(6));

            if (payload.text) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...m, content: m.content + payload.text } : m,
                ),
              );
            }

            if (payload.snapshot) {
              setSnapshots((prev) => [
                ...prev,
                {
                  id: payload.snapshot.id,
                  version: payload.snapshot.version,
                  label: payload.snapshot.label,
                  content: JSON.stringify(payload.snapshot.content),
                  selected: false,
                  createdAt: new Date().toISOString(),
                },
              ]);
            }

            if (payload.character) {
              const c = payload.character as {
                id: string;
                name: string;
                prompt?: string;
                uri?: string;
                groupKey?: string;
                version?: number;
                pending?: boolean;
                failed?: boolean;
                error?: string;
              };
              setCharacters((prev) => {
                const idx = prev.findIndex((x) => x.id === c.id);
                const prevRow = idx >= 0 ? prev[idx] : undefined;
                const gk = c.groupKey ?? prevRow?.groupKey ?? c.id;
                const ver = c.version ?? prevRow?.version ?? 1;
                let row: CharacterAsset;
                if (c.pending === true) {
                  row = {
                    id: c.id,
                    name: c.name,
                    prompt: c.prompt ?? prevRow?.prompt ?? "",
                    groupKey: gk,
                    version: ver,
                    selected: prevRow?.selected ?? true,
                    pending: true,
                    failed: false,
                  };
                } else if (c.failed === true) {
                  row = {
                    id: c.id,
                    name: c.name,
                    prompt: c.prompt ?? prevRow?.prompt ?? "",
                    groupKey: gk,
                    version: ver,
                    selected: prevRow?.selected ?? false,
                    failed: true,
                    pending: false,
                    error: c.error,
                  };
                } else {
                  row = {
                    id: c.id,
                    name: c.name,
                    prompt: c.prompt ?? prevRow?.prompt ?? "",
                    uri: c.uri,
                    groupKey: gk,
                    version: ver,
                    selected: prevRow?.selected ?? true,
                    pending: false,
                    failed: false,
                  };
                }
                if (idx === -1) return [...prev, row];
                const copy = [...prev];
                copy[idx] = row;
                return copy;
              });
              setStoryboardTab("characters");
            }

            if (payload.keyframe) {
              const k = payload.keyframe as {
                id: string;
                beatIndex: number;
                label: string;
                prompt?: string;
                uri?: string;
                pending?: boolean;
                failed?: boolean;
                error?: string;
              };
              setKeyframes((prev) => {
                const idx = prev.findIndex((x) => x.id === k.id);
                const prevRow = idx >= 0 ? prev[idx] : undefined;
                let row: KeyframeAsset;
                if (k.pending === true) {
                  row = {
                    id: k.id,
                    beatIndex: k.beatIndex,
                    label: k.label,
                    prompt: k.prompt ?? prevRow?.prompt ?? "",
                    pending: true,
                    failed: false,
                  };
                } else if (k.failed === true) {
                  row = {
                    id: k.id,
                    beatIndex: k.beatIndex,
                    label: k.label,
                    prompt: k.prompt ?? prevRow?.prompt ?? "",
                    failed: true,
                    pending: false,
                    error: k.error,
                  };
                } else {
                  row = {
                    id: k.id,
                    beatIndex: k.beatIndex,
                    label: k.label,
                    prompt: k.prompt ?? prevRow?.prompt ?? "",
                    uri: k.uri,
                    pending: false,
                    failed: false,
                  };
                }
                if (idx === -1) return [...prev, row];
                const copy = [...prev];
                copy[idx] = row;
                return copy;
              });
              setStoryboardTab("keyframes");
            }

            if (payload.status) {
              setStatus(payload.status);
            }

            if (payload.error) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...m, content: m.content + `\n\nError: ${payload.error}` } : m,
                ),
              );
            }
          } catch {
            // skip malformed SSE
          }
        }
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + "\n\nConnection lost." } : m)),
      );
    }

    setStreaming(false);
  }

  const sendBootstrapRef = useRef(false);

  async function handleApprove() {
    setApproving(true);
    try {
      const res = await fetch(`/api/sessions/${id}/approve`, { method: "POST" });
      const data = await res.json();
      if (data.status === "script_approved") {
        setStatus("script_approved");
        setNextStepsDismissed(false);
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
    if (sendBootstrapRef.current && status === "script_approved" && !streaming) {
      sendBootstrapRef.current = false;
      setInput("Begin generating character reference images.");
      setTimeout(() => {
        const syntheticInput = "Begin generating character reference images.";
        setInput("");
        const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: syntheticInput };
        setMessages((prev) => [...prev, userMsg]);
        const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "" };
        setMessages((prev) => [...prev, assistantMsg]);
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
              setStreaming(false);
              return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const payload = JSON.parse(line.slice(6));
                  if (payload.text) {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantMsg.id ? { ...m, content: m.content + payload.text } : m,
                      ),
                    );
                  }
                  if (payload.character) {
                    const c = payload.character as CharacterAsset & { pending?: boolean; failed?: boolean; error?: string };
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
                    const k = payload.keyframe as KeyframeAsset & { pending?: boolean; failed?: boolean; error?: string };
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
                        m.id === assistantMsg.id ? { ...m, content: m.content + `\n\nError: ${payload.error}` } : m,
                      ),
                    );
                  }
                } catch { /* skip malformed SSE */ }
              }
            }
          } catch {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + "\n\nConnection lost." } : m)),
            );
          }
          setStreaming(false);
        })();
      }, 100);
    }
  }, [status, streaming, id]);

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
      prev.map((c) =>
        c.groupKey === groupKey ? { ...c, selected: c.id === assetId } : c,
      ),
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
      if (data.asset) {
        setProductImage(data.asset.uri);
      }
    } catch {
      alert("Upload failed");
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function parseBeats(content: string): Beat[] {
    try {
      const parsed = JSON.parse(content);
      return parsed.beats ?? [];
    } catch {
      return [];
    }
  }

  // ── Panels ──────────────────────────────────────────────────────────────

  const chatPanel = (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
        <div className="space-y-3">
          {messages.length === 0 && (
            <p className="text-center text-sm text-zinc-600 pt-16 px-4">
              {isKeyframePhase
                ? "Cast and talent were already covered in discovery (before you approved the script). Say what to generate next—character reference images, keyframes, or both—or ask to tweak a look."
                : "Describe your product, brand, audience, and what the ad should convey."}
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === "user" ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-200"
                }`}
              >
                {m.content || <span className="animate-pulse text-zinc-500">...</span>}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );

  const scriptTab = (
    <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin space-y-3">
      {snapshots.length === 0 && (
        <p className="text-xs text-zinc-600 text-center pt-8">
          No versions yet. Chat until a beat list is generated.
        </p>
      )}
      {snapshots.map((snap) => {
        const beats = parseBeats(snap.content);
        const isExpanded = expandedSnap === snap.id;
        return (
          <div
            key={snap.id}
            className={`rounded-lg border p-3 transition cursor-pointer ${
              snap.selected
                ? "border-indigo-500 bg-indigo-950/30"
                : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
            }`}
            onClick={() => setExpandedSnap(isExpanded ? null : snap.id)}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-zinc-300">v{snap.version}</span>
                {snap.selected && (
                  <span className="text-[10px] font-medium bg-indigo-600 text-white px-1.5 py-0.5 rounded">
                    Selected
                  </span>
                )}
              </div>
              <span className="text-[10px] text-zinc-600">{beats.length} beats</span>
            </div>
            {snap.label && <p className="text-xs text-zinc-400 mb-1">{snap.label}</p>}
            {!isExpanded && beats.length > 0 && (
              <p className="text-xs text-zinc-500 truncate">{beats[0]?.spokenLine}</p>
            )}
            {isExpanded && (
              <div className="mt-2 space-y-2">
                {beats.map((beat) => (
                  <div key={beat.index} className="rounded bg-zinc-800/50 px-2.5 py-2">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-medium text-indigo-400 uppercase">{beat.label}</span>
                      <span className="text-[10px] text-zinc-600">{beat.durationSec}s</span>
                    </div>
                    <p className="text-xs text-zinc-300 leading-relaxed">{beat.spokenLine}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{beat.description}</p>
                  </div>
                ))}
                {!snap.selected && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectSnapshot(snap.id);
                    }}
                    className="w-full rounded-md bg-indigo-600 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition"
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

  const charactersTab = (() => {
    const groupKeys = Object.keys(characterGroups);
    return (
      <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
        {groupKeys.length === 0 && (
          <p className="text-xs text-zinc-600 text-center pt-8">
            No characters yet. Start generating to see them here.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {groupKeys.map((gk) => {
            const versions = characterGroups[gk];
            const display = versions.find((v) => v.selected) ?? versions[0];
            if (!display) return null;
            const totalVersions = versions.length;
            return (
              <div
                key={gk}
                className={`rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden transition ${
                  display.uri && !display.failed ? "cursor-pointer hover:border-zinc-600" : "cursor-default"
                }`}
                onClick={() => {
                  if (display.uri && !display.failed) setSelectedImage({ uri: display.uri, label: display.name });
                }}
              >
                <div className="aspect-square bg-zinc-950 relative">
                  {display.pending && (
                    <div className="absolute inset-0 animate-pulse bg-zinc-800/80 flex items-center justify-center">
                      <span className="text-[10px] text-zinc-500 px-2 text-center">Generating…</span>
                    </div>
                  )}
                  {display.failed && (
                    <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center p-2">
                      <span className="text-[10px] text-red-400 text-center leading-snug">
                        {display.error ?? "Failed"}
                      </span>
                    </div>
                  )}
                  {display.uri && !display.pending && !display.failed && (
                    <img
                      src={display.uri}
                      alt={display.name}
                      className="w-full h-full object-cover"
                    />
                  )}
                  {totalVersions > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setVersionPickerGroup(gk);
                      }}
                      className="absolute top-1.5 right-1.5 bg-black/70 text-[10px] text-zinc-300 px-1.5 py-0.5 rounded font-medium hover:bg-black/90 transition"
                    >
                      v{display.version} of {totalVersions}
                    </button>
                  )}
                </div>
                <div className="p-2">
                  <p className="text-xs font-medium text-zinc-300 truncate">{display.name}</p>
                  <p className="text-[10px] text-zinc-600 truncate mt-0.5">{display.prompt}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  })();

  const keyframesTab = (
    <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
      {keyframes.length === 0 && (
        <p className="text-xs text-zinc-600 text-center pt-8">
          No keyframes yet. Start generating to see them here.
        </p>
      )}
      <div className="space-y-3">
        {keyframes.map((kf) => (
          <div
            key={kf.id}
            className={`rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden transition ${
              kf.uri && !kf.failed ? "cursor-pointer hover:border-zinc-600" : "cursor-default"
            }`}
            onClick={() => {
              if (kf.uri && !kf.failed) setSelectedImage({ uri: kf.uri, label: kf.label });
            }}
          >
            <div className="aspect-video bg-zinc-950 relative">
              {kf.pending && (
                <div className="absolute inset-0 animate-pulse bg-zinc-800/80 flex items-center justify-center">
                  <span className="text-[10px] text-zinc-500 px-2 text-center">Generating…</span>
                </div>
              )}
              {kf.failed && (
                <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center p-2">
                  <span className="text-[10px] text-red-400 text-center leading-snug">
                    {kf.error ?? "Failed"}
                  </span>
                </div>
              )}
              {kf.uri && !kf.pending && !kf.failed && (
                <img
                  src={kf.uri}
                  alt={kf.label}
                  className="w-full h-full object-cover"
                />
              )}
            </div>
            <div className="p-2">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-medium text-indigo-400 uppercase">Beat {kf.beatIndex}</span>
                <span className="text-xs text-zinc-300">{kf.label}</span>
              </div>
              <p className="text-[10px] text-zinc-600 truncate">{kf.prompt}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const storyboardPanel = (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Tab bar */}
      <div className="flex border-b border-zinc-800 shrink-0">
        {(["script", "characters", "keyframes"] as StoryboardTab[]).map((tab) => {
          const count =
            tab === "script" ? snapshots.length : tab === "characters" ? characters.length : keyframes.length;
          return (
            <button
              key={tab}
              onClick={() => setStoryboardTab(tab)}
              className={`flex-1 px-3 py-2.5 text-xs font-medium transition ${
                storyboardTab === tab
                  ? "text-indigo-400 border-b-2 border-indigo-500"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {count > 0 && (
                <span className="ml-1 text-[10px] text-zinc-600">({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Product image upload (visible in keyframe phase) */}
      {isKeyframePhase && (
        <div className="px-4 py-2 border-b border-zinc-800 shrink-0">
          {productImage ? (
            <div className="flex items-center gap-2">
              <img src={productImage} alt="Product" className="w-8 h-8 rounded object-cover" />
              <span className="text-xs text-zinc-400">Product image uploaded</span>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-[10px] text-indigo-400 hover:text-indigo-300"
              >
                Replace
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full rounded-md border border-dashed border-zinc-700 py-2 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition"
            >
              {uploading ? "Uploading..." : "+ Add product image (optional)"}
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

      {/* Tab content */}
      {storyboardTab === "script" && scriptTab}
      {storyboardTab === "characters" && charactersTab}
      {storyboardTab === "keyframes" && keyframesTab}
    </div>
  );

  // ── Image preview lightbox ──────────────────────────────────────────────

  const lightbox = selectedImage && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={() => setSelectedImage(null)}
    >
      <div
        className="max-w-2xl max-h-[80vh] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={selectedImage.uri}
          alt={selectedImage.label}
          className="max-w-full max-h-[70vh] object-contain"
        />
        <div className="px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-zinc-300">{selectedImage.label}</span>
          <button
            onClick={() => setSelectedImage(null)}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  const versionPickerModal = versionPickerGroup && characterGroups[versionPickerGroup] && (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={() => setVersionPickerGroup(null)}
    >
      <div
        className="w-full max-w-xl rounded-t-xl sm:rounded-xl bg-zinc-900 border border-zinc-700 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-200">
            Select version — {characterGroups[versionPickerGroup][0]?.name}
          </h3>
          <button
            onClick={() => setVersionPickerGroup(null)}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Close
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
                className={`shrink-0 rounded-lg border overflow-hidden transition w-28 ${
                  v.selected
                    ? "border-indigo-500 ring-2 ring-indigo-500/40"
                    : "border-zinc-700 hover:border-zinc-500"
                }`}
              >
                <div className="aspect-square bg-zinc-950 relative">
                  {v.uri && !v.failed ? (
                    <img src={v.uri} alt={v.name} className="w-full h-full object-cover" />
                  ) : v.failed ? (
                    <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center">
                      <span className="text-[10px] text-red-400">Failed</span>
                    </div>
                  ) : (
                    <div className="absolute inset-0 animate-pulse bg-zinc-800/80 flex items-center justify-center">
                      <span className="text-[10px] text-zinc-500">…</span>
                    </div>
                  )}
                </div>
                <div className="p-1.5 text-center">
                  <span className="text-[10px] font-medium text-zinc-300">v{v.version}</span>
                  {v.selected && (
                    <span className="ml-1 text-[10px] bg-indigo-600 text-white px-1 py-0.5 rounded">Active</span>
                  )}
                </div>
              </button>
            ))}
        </div>
      </div>
    </div>
  );

  // ── Layout ──────────────────────────────────────────────────────────────

  return (
    <main className="flex h-screen flex-col">
      {lightbox}
      {versionPickerModal}

      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 py-2.5 backdrop-blur shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-zinc-300">Adloom</h1>
          {isKeyframePhase && (
            <span className="text-[10px] font-medium bg-emerald-900/50 text-emerald-400 px-2 py-0.5 rounded">
              Characters & keyframes
            </span>
          )}
        </div>

        {/* Mobile tab toggle */}
        <div className="flex items-center gap-2 md:hidden">
          <button
            onClick={() => setActiveTab("chat")}
            className={`text-xs px-2.5 py-1 rounded ${activeTab === "chat" ? "bg-zinc-800 text-zinc-200" : "text-zinc-500"}`}
          >
            Chat
          </button>
          <button
            onClick={() => {
              setActiveTab("storyboard");
              fetchSnapshots();
            }}
            className={`text-xs px-2.5 py-1 rounded ${activeTab === "storyboard" ? "bg-zinc-800 text-zinc-200" : "text-zinc-500"}`}
          >
            Storyboard
          </button>
        </div>

        {status === "chatting" && (
          <button
            onClick={handleApprove}
            disabled={approving || snapshots.length === 0}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-500 disabled:opacity-40"
          >
            {approving ? "Building briefs..." : "Approve script"}
          </button>
        )}
      </header>

      {isKeyframePhase && !nextStepsDismissed && (
        <div className="shrink-0 border-b border-emerald-900/50 bg-emerald-950/25 px-4 py-3">
          <div className="mx-auto flex max-w-4xl flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm font-medium text-emerald-200">Script approved — production brief saved</p>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Your <span className="text-zinc-300">brief</span> (brand, product, creative direction, scenes, characters,
                audio, localization) is stored for this session.
              </p>
              <p className="text-xs text-zinc-400 leading-relaxed">
                You already went through brand, hook, and cast in the earlier chat. Those answers are in the brief—you
                only need to repeat them if you want to change direction.
              </p>
              <ol className="list-decimal list-inside text-xs text-zinc-400 space-y-1 pt-1">
                <li>
                  <span className="text-zinc-300">Chat:</span> Ask for{" "}
                  <span className="text-zinc-300">character reference images</span>,{" "}
                  <span className="text-zinc-300">keyframes</span> for specific beats, or both. The assistant pulls from
                  your brief and calls Nano Banana when it needs images.
                </li>
                <li>
                  <span className="text-zinc-300">Optional:</span> In Storyboard, add a product image so shots can match
                  your packshot.
                </li>
                <li>
                  <span className="text-zinc-300">Storyboard tabs:</span> Watch <span className="text-zinc-300">Characters</span>{" "}
                  and <span className="text-zinc-300">Keyframes</span> as assets appear.
                </li>
              </ol>
            </div>
            <button
              type="button"
              onClick={() => setNextStepsDismissed(true)}
              className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 sm:pt-0.5"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Split pane */}
      <div className="flex flex-1 min-h-0">
        {/* Chat — left on desktop */}
        <div
          className={`flex flex-col md:w-[55%] md:border-r md:border-zinc-800 w-full ${
            activeTab !== "chat" ? "hidden md:flex" : "flex"
          }`}
        >
          {chatPanel}
        </div>

        {/* Storyboard — right on desktop */}
        <div
          className={`flex flex-col md:w-[45%] w-full ${
            activeTab !== "storyboard" ? "hidden md:flex" : "flex"
          }`}
        >
          {storyboardPanel}
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isKeyframePhase
                ? "e.g. Generate character refs from the brief — or keyframes for the beats"
                : "Describe your ad concept..."
            }
            rows={1}
            className="flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-indigo-500"
          />
          <button
            onClick={send}
            disabled={streaming || !input.trim()}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </main>
  );
}
