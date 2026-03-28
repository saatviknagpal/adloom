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

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string>("chatting");
  const [approving, setApproving] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [expandedSnap, setExpandedSnap] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "versions">("chat");
  const bottomRef = useRef<HTMLDivElement>(null);

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
            data.messages.map((m: { id: string; role: string; content: string }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
          );
        }
        if (data.status) setStatus(data.status);
        if (data.snapshots) setSnapshots(data.snapshots);
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
              setSnapshots((prev) => [...prev, {
                id: payload.snapshot.id,
                version: payload.snapshot.version,
                label: payload.snapshot.label,
                content: JSON.stringify(payload.snapshot.content),
                selected: false,
                createdAt: new Date().toISOString(),
              }]);
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

  async function handleApprove() {
    setApproving(true);
    try {
      const res = await fetch(`/api/sessions/${id}/approve`, { method: "POST" });
      const data = await res.json();
      if (data.status === "script_approved") {
        setStatus("script_approved");
      } else if (data.error) {
        alert(`Approval failed: ${data.error}`);
      }
    } catch {
      alert("Network error during approval");
    }
    setApproving(false);
  }

  async function handleSelectSnapshot(snapshotId: string) {
    await fetch(`/api/sessions/${id}/snapshots/${snapshotId}/select`, { method: "POST" });
    setSnapshots((prev) =>
      prev.map((s) => ({ ...s, selected: s.id === snapshotId })),
    );
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

  if (status === "script_approved") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
        <div className="rounded-xl border border-green-800 bg-green-950/30 p-8 text-center max-w-md">
          <h2 className="text-xl font-semibold text-green-400 mb-2">Script approved</h2>
          <p className="text-zinc-400 text-sm">
            Your beat list and localized scripts are locked. Next step: keyframe generation (coming soon).
          </p>
        </div>
      </main>
    );
  }

  const chatPanel = (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
        <div className="space-y-3">
          {messages.length === 0 && (
            <p className="text-center text-sm text-zinc-600 pt-16">
              Describe your product, brand, audience, and what the ad should convey.
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

  const snapshotPanel = (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="px-4 py-3 border-b border-zinc-800">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Versions</h2>
      </div>
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
                      onClick={(e) => { e.stopPropagation(); handleSelectSnapshot(snap.id); }}
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
    </div>
  );

  return (
    <main className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 py-2.5 backdrop-blur shrink-0">
        <h1 className="text-sm font-semibold text-zinc-300">Adloom</h1>

        {/* Mobile tab toggle */}
        <div className="flex items-center gap-2 md:hidden">
          <button
            onClick={() => setActiveTab("chat")}
            className={`text-xs px-2.5 py-1 rounded ${activeTab === "chat" ? "bg-zinc-800 text-zinc-200" : "text-zinc-500"}`}
          >
            Chat
          </button>
          <button
            onClick={() => { setActiveTab("versions"); fetchSnapshots(); }}
            className={`text-xs px-2.5 py-1 rounded ${activeTab === "versions" ? "bg-zinc-800 text-zinc-200" : "text-zinc-500"}`}
          >
            Versions{snapshots.length > 0 ? ` (${snapshots.length})` : ""}
          </button>
        </div>

        <button
          onClick={handleApprove}
          disabled={approving || snapshots.length === 0}
          className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-500 disabled:opacity-40"
        >
          {approving ? "Localizing..." : "Approve script"}
        </button>
      </header>

      {/* Split pane */}
      <div className="flex flex-1 min-h-0">
        {/* Chat — left on desktop, toggled on mobile */}
        <div className={`flex flex-col md:w-[55%] md:border-r md:border-zinc-800 w-full ${activeTab !== "chat" ? "hidden md:flex" : "flex"}`}>
          {chatPanel}
        </div>

        {/* Snapshots — right on desktop, toggled on mobile */}
        <div className={`flex flex-col md:w-[45%] w-full ${activeTab !== "versions" ? "hidden md:flex" : "flex"}`}>
          {snapshotPanel}
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your ad concept..."
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
