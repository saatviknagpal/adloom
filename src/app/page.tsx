"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleStart() {
    setLoading(true);
    const res = await fetch("/api/sessions", { method: "POST" });
    const data = (await res.json()) as { id: string };
    router.push(`/chat/${data.id}`);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <div className="text-center space-y-4 max-w-lg">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-50">Adloom</h1>
        <p className="text-zinc-400 text-lg leading-relaxed">
          One concept. Three markets. Locale-adaptive video ads — from brief to export.
        </p>
      </div>

      <button
        onClick={handleStart}
        disabled={loading}
        className="rounded-xl bg-indigo-600 px-8 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
      >
        {loading ? "Creating session..." : "Start new ad"}
      </button>

      <div className="mt-8 grid grid-cols-3 gap-6 text-center text-sm text-zinc-500 max-w-md">
        <div>
          <div className="text-2xl mb-1">1</div>
          <p>Chat to fill your brief &amp; scene versions</p>
        </div>
        <div>
          <div className="text-2xl mb-1">2</div>
          <p>Review keyframes per locale</p>
        </div>
        <div>
          <div className="text-2xl mb-1">3</div>
          <p>Export 3 localized videos</p>
        </div>
      </div>
    </main>
  );
}
