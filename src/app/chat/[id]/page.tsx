"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string>("chatting");
  const [approving, setApproving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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
          const payload = JSON.parse(line.slice(6));
          if (payload.text) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, content: m.content + payload.text } : m,
              ),
            );
          }
          if (payload.error) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, content: m.content + `\n\nError: ${payload.error}` } : m,
              ),
            );
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
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

  return (
    <main className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-6 py-3 backdrop-blur">
        <h1 className="text-sm font-semibold text-zinc-300">Adloom — Chat</h1>
        <button
          onClick={handleApprove}
          disabled={approving || messages.length < 2}
          className="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-green-500 disabled:opacity-40"
        >
          {approving ? "Extracting brief..." : "Approve script"}
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 scrollbar-thin">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <p className="text-center text-sm text-zinc-600 pt-20">
              Describe your product, brand, audience, and what the ad should convey.
            </p>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-200"
                }`}
              >
                {m.content || <span className="animate-pulse text-zinc-500">...</span>}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your ad concept..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-indigo-500"
          />
          <button
            onClick={send}
            disabled={streaming || !input.trim()}
            className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </main>
  );
}
