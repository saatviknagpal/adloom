export type Region = "US" | "IN" | "CN";

export const REGION_CONFIG: Record<Region, { label: string; language: string; locale: string }> = {
  US: { label: "United States", language: "English", locale: "en-US" },
  IN: { label: "India", language: "Hindi", locale: "hi-IN" },
  CN: { label: "China", language: "Mandarin", locale: "zh-CN" },
};

export type SessionStatus =
  | "chatting"
  | "script_approved"
  | "keyframes_review"
  | "keyframes_approved"
  | "generating"
  | "done"
  | "failed";

export type Beat = {
  index: number;
  label: string;
  description: string;
  spokenLine: string;
  durationSec: number;
};

export type StructuredBrief = {
  product: string;
  brandName: string;
  targetAudience: string;
  tone: string;
  offer: string;
  visualStyle: string;
  beats: Beat[];
  localizedScripts: Record<Region, { lines: string[] }>;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  imageUrl?: string | null;
  createdAt: string;
};
