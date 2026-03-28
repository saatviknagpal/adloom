"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/* ── Icon helpers (inline SVG, no external dependency) ───────────────────── */

function IconEditNote({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
    </svg>
  );
}

function IconBolt({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
      <path d="M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.48 10.94 10.42 7.54 13.01 3h1l-1 7h3.51c.4 0 .62.19.4.66C12.97 17.55 11 21 11 21z" />
    </svg>
  );
}

function IconLanguage({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
      <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" />
    </svg>
  );
}

function IconCarousel({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
      <path d="M2 7h4v10H2V7zm5-2h10v14H7V5zm11 2h4v10h-4V7z" />
    </svg>
  );
}

function IconPlay({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" />
    </svg>
  );
}

function IconArrow({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z" />
    </svg>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

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
    <div className="min-h-screen overflow-x-hidden bg-[#0b1326] text-[#dae2fd] selection:bg-[#8083ff]/40">
      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 w-full z-50 bg-[#0b1326]/80 backdrop-blur-xl bg-gradient-to-b from-[#171f33] to-transparent">
        <div className="flex justify-between items-center px-6 md:px-8 py-4 max-w-7xl mx-auto">
          <div className="text-2xl font-bold tracking-tighter text-[#c0c1ff] font-[var(--font-manrope)]">
            Adloom
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm font-medium">
            <a href="#features" className="text-[#c0c1ff] font-bold border-b-2 border-[#c0c1ff] pb-1">Features</a>
            <a href="#how" className="text-[#c7c4d7] hover:text-[#dae2fd] transition-colors">How it Works</a>
          </div>
          <button
            onClick={handleStart}
            disabled={loading}
            className="bg-gradient-to-br from-[#c0c1ff] to-[#8083ff] text-[#1000a9] px-5 py-2.5 rounded-lg font-bold text-sm shadow-lg hover:shadow-[0_0_20px_rgba(192,193,255,0.3)] transition-all active:scale-95 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Start Free"}
          </button>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative pt-32 pb-20 px-6 md:px-8 overflow-hidden">
        {/* Ambient glows */}
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-[#c0c1ff]/10 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute bottom-[20%] right-[-5%] w-[40%] h-[40%] bg-[#571bc1]/20 rounded-full blur-[100px] pointer-events-none" />

        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center">
          {/* Left — copy */}
          <div className="lg:col-span-6 z-10 animate-fade-in-up">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#222a3d] border border-[#464554]/20 mb-8">
              <span className="w-2 h-2 rounded-full bg-[#ffb783]" />
              <span className="text-[11px] font-medium tracking-wide text-[#c7c4d7] uppercase">
                AI Video Localization Engine
              </span>
            </div>

            <h1 className="font-[var(--font-manrope)] text-4xl sm:text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6">
              Create{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#c0c1ff] via-[#d0bcff] to-[#ffb783]">
                Localized
              </span>{" "}
              Video Ads in Minutes
            </h1>

            <p className="text-lg md:text-xl text-[#c7c4d7] max-w-xl mb-10 leading-relaxed">
              Adloom generates culturally-adapted video ads for the US, India, and China from a single creative brief. Your global reach, automated.
            </p>

            <div className="flex flex-col sm:flex-row gap-4">
              <button
                onClick={handleStart}
                disabled={loading}
                className="bg-gradient-to-br from-[#c0c1ff] to-[#8083ff] text-[#1000a9] px-8 py-4 rounded-lg font-bold text-lg hover:shadow-[0_0_24px_rgba(192,193,255,0.4)] transition-all disabled:opacity-50"
              >
                {loading ? "Creating session..." : "Start Creating"}
              </button>
              <button className="flex items-center justify-center gap-2 px-8 py-4 rounded-lg font-bold text-lg border border-[#464554]/30 hover:bg-[#31394d] transition-all text-[#dae2fd]">
                <IconPlay className="w-5 h-5" />
                <span>Watch Demo</span>
              </button>
            </div>
          </div>

          {/* Right — editor mockup */}
          <div className="lg:col-span-6 relative z-10 animate-fade-in-up delay-200">
            <div className="relative glass-card p-4 rounded-xl border border-[#464554]/20 glow-shadow overflow-hidden">
              {/* Window chrome */}
              <div className="flex items-center gap-2 mb-4 px-2">
                <div className="w-2.5 h-2.5 rounded-full bg-[#ffb4ab]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#ffb783]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#c0c1ff]" />
                <div className="flex-grow" />
                <div className="text-[10px] text-[#c7c4d7] font-mono uppercase tracking-widest opacity-50">
                  Editor View
                </div>
              </div>

              {/* Three locale previews */}
              <div className="grid grid-cols-3 gap-3">
                {/* US */}
                <div className="space-y-3">
                  <div className="aspect-[9/16] rounded-lg bg-[#2d3449] relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-br from-[#c0c1ff]/20 to-[#8083ff]/10" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3">
                      <div className="w-10 h-10 rounded-full bg-[#c0c1ff]/20 flex items-center justify-center">
                        <span className="text-sm font-bold text-[#c0c1ff]">US</span>
                      </div>
                      <div className="w-full space-y-1.5 mt-2">
                        <div className="h-1.5 w-full bg-[#c0c1ff]/20 rounded-full" />
                        <div className="h-1.5 w-3/4 bg-[#c0c1ff]/15 rounded-full" />
                        <div className="h-1.5 w-5/6 bg-[#c0c1ff]/10 rounded-full" />
                      </div>
                    </div>
                    <div className="absolute bottom-3 left-3">
                      <div className="text-[10px] font-bold text-[#c0c1ff] mb-1">US Version</div>
                      <div className="w-12 h-1 bg-[#c0c1ff]/40 rounded-full" />
                    </div>
                  </div>
                  <div className="h-2 w-full bg-[#222a3d] rounded-full" />
                </div>

                {/* India */}
                <div className="space-y-3 pt-4">
                  <div className="aspect-[9/16] rounded-lg bg-[#2d3449] relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-br from-[#ffb783]/20 to-[#d97721]/10" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3">
                      <div className="w-10 h-10 rounded-full bg-[#ffb783]/20 flex items-center justify-center">
                        <span className="text-sm font-bold text-[#ffb783]">IN</span>
                      </div>
                      <div className="w-full space-y-1.5 mt-2">
                        <div className="h-1.5 w-full bg-[#ffb783]/20 rounded-full" />
                        <div className="h-1.5 w-2/3 bg-[#ffb783]/15 rounded-full" />
                        <div className="h-1.5 w-4/5 bg-[#ffb783]/10 rounded-full" />
                      </div>
                    </div>
                    <div className="absolute bottom-3 left-3">
                      <div className="text-[10px] font-bold text-[#ffb783] mb-1">India Version</div>
                      <div className="w-12 h-1 bg-[#ffb783]/40 rounded-full" />
                    </div>
                  </div>
                  <div className="h-2 w-3/4 bg-[#222a3d] rounded-full" />
                </div>

                {/* China */}
                <div className="space-y-3">
                  <div className="aspect-[9/16] rounded-lg bg-[#2d3449] relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-br from-[#d0bcff]/20 to-[#571bc1]/10" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3">
                      <div className="w-10 h-10 rounded-full bg-[#d0bcff]/20 flex items-center justify-center">
                        <span className="text-sm font-bold text-[#d0bcff]">CN</span>
                      </div>
                      <div className="w-full space-y-1.5 mt-2">
                        <div className="h-1.5 w-full bg-[#d0bcff]/20 rounded-full" />
                        <div className="h-1.5 w-4/5 bg-[#d0bcff]/15 rounded-full" />
                        <div className="h-1.5 w-2/3 bg-[#d0bcff]/10 rounded-full" />
                      </div>
                    </div>
                    <div className="absolute bottom-3 left-3">
                      <div className="text-[10px] font-bold text-[#d0bcff] mb-1">China Version</div>
                      <div className="w-12 h-1 bg-[#d0bcff]/40 rounded-full" />
                    </div>
                  </div>
                  <div className="h-2 w-full bg-[#222a3d] rounded-full" />
                </div>
              </div>

              {/* Floating AI badge */}
              <div className="absolute -bottom-4 -right-4 w-24 h-24 bg-[#571bc1]/30 backdrop-blur-xl border border-[#d0bcff]/20 rounded-2xl flex items-center justify-center">
                <div className="w-14 h-14 border-2 border-dashed border-[#d0bcff]/30 rounded-full flex items-center justify-center relative">
                  <span className="text-[#d0bcff] text-xl">&#10024;</span>
                  <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#d0bcff] rounded-full shadow-[0_0_8px_#d0bcff]" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features Bento Grid ──────────────────────────────────────────── */}
      <section id="features" className="py-24 px-6 md:px-8 bg-[#131b2e] relative">
        <div className="max-w-7xl mx-auto">
          <div className="max-w-2xl mb-16">
            <h2 className="font-[var(--font-manrope)] text-3xl md:text-5xl font-bold mb-4">
              Precision tools for the modern creator.
            </h2>
            <p className="text-[#c7c4d7] text-lg">
              Every feature is engineered to collapse the distance between idea and global execution.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            {/* AI Script Writing — wide */}
            <div className="md:col-span-7 group bg-[#222a3d] p-8 rounded-2xl border border-[#464554]/10 hover:border-[#c0c1ff]/30 transition-all duration-500 overflow-hidden relative">
              <div className="absolute top-0 right-0 w-64 h-64 bg-[#c0c1ff]/5 rounded-full blur-3xl group-hover:bg-[#c0c1ff]/10 transition-colors" />
              <div className="relative z-10 flex flex-col h-full">
                <div className="w-12 h-12 rounded-xl bg-[#c0c1ff]/10 flex items-center justify-center text-[#c0c1ff] mb-6">
                  <IconEditNote className="w-6 h-6" />
                </div>
                <h3 className="font-[var(--font-manrope)] text-2xl font-bold mb-3">AI Script Writing</h3>
                <p className="text-[#c7c4d7] mb-8 max-w-sm">
                  Automatically generate scripts tailored to local idioms and trends. Our AI understands cultural subtext, not just literal translation.
                </p>
                <div className="mt-auto pt-8">
                  <div className="glass-card p-4 rounded-xl border border-[#464554]/20 flex flex-col gap-3">
                    <div className="flex gap-2">
                      <span className="px-2 py-0.5 rounded-full bg-[#c0c1ff]/20 text-[10px] text-[#c0c1ff] font-bold">
                        SLANG DETECTED
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-[#ffb783]/20 text-[10px] text-[#ffb783] font-bold">
                        HINDI OPTIMIZED
                      </span>
                    </div>
                    <div className="h-2 w-full bg-[#31394d] rounded-full" />
                    <div className="h-2 w-4/5 bg-[#31394d] rounded-full" />
                  </div>
                </div>
              </div>
            </div>

            {/* One-Click Video Gen — narrow */}
            <div className="md:col-span-5 bg-gradient-to-br from-[#571bc1] to-[#2d3449] p-8 rounded-2xl border border-[#464554]/10 relative overflow-hidden group">
              <div className="relative z-10">
                <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center text-[#d0bcff] mb-6">
                  <IconBolt className="w-6 h-6" />
                </div>
                <h3 className="font-[var(--font-manrope)] text-2xl font-bold mb-3">One-Click Video Generation</h3>
                <p className="text-[#c7c4d7] mb-6">
                  Create final video assets with zero rendering friction. From brief to export in minutes.
                </p>
                <span className="inline-flex items-center gap-1 text-[#c0c1ff] font-bold text-sm group-hover:translate-x-1 transition-transform">
                  Explore workflow <IconArrow className="w-4 h-4" />
                </span>
              </div>
              <div className="absolute -bottom-8 -right-8 opacity-20 group-hover:opacity-40 transition-opacity">
                <IconBolt className="w-28 h-28 text-[#c0c1ff]" />
              </div>
            </div>

            {/* Multi-Region Localization — narrow */}
            <div className="md:col-span-5 bg-[#171f33] p-8 rounded-2xl border border-[#464554]/10 hover:border-[#ffb783]/30 transition-all duration-500">
              <div className="w-12 h-12 rounded-xl bg-[#ffb783]/10 flex items-center justify-center text-[#ffb783] mb-6">
                <IconLanguage className="w-6 h-6" />
              </div>
              <h3 className="font-[var(--font-manrope)] text-2xl font-bold mb-3">Multi-Region Localization</h3>
              <p className="text-[#c7c4d7]">
                Adapt voiceovers and cultural nuances with professional-grade accuracy. US English, Hindi, and Mandarin out of the box.
              </p>
            </div>

            {/* Keyframe Storyboarding — wide */}
            <div className="md:col-span-7 bg-[#222a3d] p-8 rounded-2xl border border-[#464554]/10 hover:border-[#d0bcff]/30 transition-all duration-500 relative overflow-hidden">
              <div className="flex flex-col md:flex-row gap-8 items-center">
                <div className="flex-1">
                  <div className="w-12 h-12 rounded-xl bg-[#d0bcff]/10 flex items-center justify-center text-[#d0bcff] mb-6">
                    <IconCarousel className="w-6 h-6" />
                  </div>
                  <h3 className="font-[var(--font-manrope)] text-2xl font-bold mb-3">Keyframe Storyboarding</h3>
                  <p className="text-[#c7c4d7]">
                    Visual guides for each market&apos;s aesthetic preferences, ensuring visual harmony across cultures.
                  </p>
                </div>
                <div className="flex-1 w-full">
                  <div className="grid grid-cols-2 gap-2">
                    {["A", "B", "C", "D"].map((v) => (
                      <div
                        key={v}
                        className="aspect-video bg-[#31394d] rounded-lg border border-[#464554]/20 flex items-center justify-center"
                      >
                        <span className="text-[8px] text-[#908fa0] tracking-widest uppercase">
                          Visual {v}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it Works ─────────────────────────────────────────────────── */}
      <section id="how" className="py-24 px-6 md:px-8 relative overflow-hidden">
        <div className="max-w-7xl mx-auto text-center mb-16">
          <h2 className="font-[var(--font-manrope)] text-3xl md:text-5xl font-bold mb-4">
            Three steps. Global reach.
          </h2>
          <p className="text-[#c7c4d7] text-lg max-w-xl mx-auto">
            From creative brief to localized video ads — no manual editing required.
          </p>
        </div>

        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              step: "01",
              title: "Chat your brief",
              desc: "Answer a few questions to build your brand story, scenes, and cast. Our AI guides the conversation.",
              color: "#c0c1ff",
            },
            {
              step: "02",
              title: "Review keyframes",
              desc: "AI generates character references and scene keyframes. Pick versions, tweak prompts, approve the look.",
              color: "#d0bcff",
            },
            {
              step: "03",
              title: "Export 3 localized videos",
              desc: "Get culturally-adapted video ads for the US, India, and China — voiceovers, copy, and visuals included.",
              color: "#ffb783",
            },
          ].map((item) => (
            <div
              key={item.step}
              className="group relative bg-[#171f33] p-8 rounded-2xl border border-[#464554]/10 hover:border-[color:var(--c)]/30 transition-all duration-500"
              style={{ "--c": item.color } as React.CSSProperties}
            >
              <div
                className="text-5xl font-[var(--font-manrope)] font-extrabold mb-4 opacity-20"
                style={{ color: item.color }}
              >
                {item.step}
              </div>
              <h3 className="font-[var(--font-manrope)] text-xl font-bold mb-3">{item.title}</h3>
              <p className="text-[#c7c4d7] text-sm leading-relaxed">{item.desc}</p>
              <div
                className="absolute top-0 right-0 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-10 transition-opacity pointer-events-none"
                style={{ background: item.color }}
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Social proof ─────────────────────────────────────────────────── */}
      <section className="py-16 px-6 md:px-8 overflow-hidden">
        <div className="max-w-7xl mx-auto text-center">
          <p className="font-[var(--font-manrope)] text-sm font-bold text-[#c0c1ff] tracking-widest uppercase mb-10">
            Trusted by global narrative makers
          </p>
          <div className="flex flex-wrap justify-center gap-12 opacity-30">
            {["VECTRA", "LUMOS", "SYNTH", "AXON"].map((name) => (
              <span key={name} className="font-[var(--font-manrope)] font-black text-2xl">{name}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 md:px-8">
        <div className="max-w-5xl mx-auto rounded-3xl bg-gradient-to-tr from-[#131b2e] via-[#222a3d] to-[#131b2e] p-12 md:p-20 text-center border border-[#464554]/20 relative overflow-hidden">
          <div className="absolute inset-0 opacity-10 pointer-events-none bg-[radial-gradient(ellipse_at_center,_#c0c1ff_0%,_transparent_70%)]" />
          <div className="relative z-10">
            <h2 className="font-[var(--font-manrope)] text-3xl md:text-6xl font-extrabold mb-8 tracking-tight">
              Ready to take your stories global?
            </h2>
            <p className="text-[#c7c4d7] text-xl max-w-2xl mx-auto mb-12 leading-relaxed">
              Join brands automating their international video production with Adloom.
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-6">
              <button
                onClick={handleStart}
                disabled={loading}
                className="bg-[#c0c1ff] text-[#1000a9] px-10 py-5 rounded-xl font-bold text-lg shadow-xl hover:scale-105 transition-transform disabled:opacity-50"
              >
                {loading ? "Creating..." : "Get Started Now"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="w-full border-t border-[#464554]/20 bg-[#0b1326]">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 px-6 md:px-8 py-16 max-w-7xl mx-auto">
          <div className="col-span-2 md:col-span-1">
            <div className="text-xl font-bold text-[#c0c1ff] mb-4 font-[var(--font-manrope)]">Adloom</div>
            <p className="text-sm text-[#c7c4d7] max-w-xs leading-relaxed">
              Locale-adaptive video ads — from brief to export.
            </p>
          </div>
          {[
            { title: "Product", links: ["Features", "Templates", "Integrations"] },
            { title: "Company", links: ["About Us", "Careers", "Blog"] },
            { title: "Legal", links: ["Privacy", "Terms", "Security"] },
          ].map((col) => (
            <div key={col.title}>
              <h4 className="font-bold text-sm mb-5 uppercase tracking-wider">{col.title}</h4>
              <ul className="space-y-3 text-sm text-[#c7c4d7]">
                {col.links.map((l) => (
                  <li key={l}>
                    <a href="#" className="hover:text-[#ffb783] transition-colors">{l}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="max-w-7xl mx-auto px-6 md:px-8 py-6 border-t border-[#464554]/10 text-center md:text-left">
          <p className="text-sm text-[#c7c4d7] opacity-70">&copy; 2025 Adloom.</p>
        </div>
      </footer>
    </div>
  );
}
