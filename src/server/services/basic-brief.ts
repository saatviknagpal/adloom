/** Empty basic-copy-shaped object (values only, no description strings). */
export const BASIC_BRIEF_EMPTY: Record<string, unknown> = {
  brand: { name: "", tagline: "" },
  product: { name: "", usp: "", images: [] as string[] },
  creative_direction: { theme: "", mood: "" },
  the_hook: { type: "", visual: "", audio: "" },
  characters: { talent_type: "", cast: [] as unknown[] },
  scenes: [] as unknown[],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMergeDraft(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = out[key];
    if (isPlainObject(pv) && isPlainObject(bv)) {
      out[key] = deepMergeDraft(bv, pv);
    } else if (Array.isArray(pv)) {
      out[key] = pv;
    } else {
      out[key] = pv;
    }
  }
  return out;
}

export function parseJsonObject(s: string | null | undefined): Record<string, unknown> {
  if (!s?.trim()) return {};
  try {
    const p = JSON.parse(s) as unknown;
    return isPlainObject(p) ? p : {};
  } catch {
    return {};
  }
}

/**
 * Discovery often saves a vibe only under `mood` while `theme` stays "". Approve-time gap-fill then
 * fills `theme` from scenes alone and can ignore the user's word. If theme is empty but mood is set,
 * reuse mood as the theme anchor (merge still protects any non-empty theme).
 */
export function seedEmptyThemeFromMood(brief: Record<string, unknown>): Record<string, unknown> {
  const cd = brief.creative_direction;
  if (!isPlainObject(cd)) return brief;
  const theme = typeof cd.theme === "string" ? cd.theme.trim() : "";
  const mood = typeof cd.mood === "string" ? cd.mood.trim() : "";
  if (theme || !mood) return brief;
  return {
    ...brief,
    creative_direction: { ...cd, theme: mood },
  };
}

/** Snapshot `content` from commit_script_version. */
export type ScriptVersionPayload = {
  label?: string;
  scenes: unknown[];
  characters: { talent_type?: string; cast?: unknown[] };
};

export function parseScriptVersion(content: string): ScriptVersionPayload | null {
  try {
    const p = JSON.parse(content) as Record<string, unknown>;
    if (!Array.isArray(p.scenes) || !isPlainObject(p.characters)) return null;
    return {
      label: typeof p.label === "string" ? p.label : undefined,
      scenes: p.scenes,
      characters: p.characters as { talent_type?: string; cast?: unknown[] },
    };
  } catch {
    return null;
  }
}

export function validateScriptVersionPayload(args: Record<string, unknown>): string | null {
  const scenes = args.scenes;
  const characters = args.characters;
  if (!Array.isArray(scenes) || scenes.length === 0) return "scenes must be a non-empty array";
  if (scenes.length > 5) return "at most 5 scenes";
  if (!isPlainObject(characters)) return "characters must be an object";
  const cast = characters.cast;
  if (!Array.isArray(cast) || cast.length === 0) return "characters.cast must be a non-empty array";
  if (cast.length > 3) return "at most 3 cast members";
  for (const s of scenes) {
    if (!isPlainObject(s)) return "each scene must be an object";
    const sn = s.scene_number;
    if (typeof sn !== "number") return "each scene needs scene_number (number)";
    if (typeof s.action_description !== "string") return "each scene needs action_description";
    if (typeof s.start_frame_description !== "string") return "each scene needs start_frame_description";
    if (typeof s.end_frame_description !== "string") return "each scene needs end_frame_description";
  }
  for (const c of cast) {
    if (!isPlainObject(c)) return "each cast entry must be an object";
    if (typeof c.role !== "string" || typeof c.description !== "string") {
      return "each cast entry needs role and description (strings)";
    }
  }
  return null;
}

/**
 * Merge draft + approved script version. Scenes and characters come **exactly** from the snapshot.
 * No generic baseline backfill — empty fields stay empty so we never overwrite user intent with template text.
 */
export function mergeApprovedBasicBrief(draftJson: string | null | undefined, snapshotContentJson: string): string {
  const draft = parseJsonObject(draftJson);
  const ver = parseScriptVersion(snapshotContentJson);
  if (!ver) throw new Error("Invalid script version snapshot");

  const basic = deepMergeDraft({ ...BASIC_BRIEF_EMPTY } as Record<string, unknown>, draft) as Record<string, unknown>;
  basic.scenes = ver.scenes;
  basic.characters = {
    talent_type: ver.characters.talent_type ?? "",
    cast: ver.characters.cast ?? [],
  };

  const product = (basic.product as Record<string, unknown>) ?? {};
  if (!Array.isArray(product.images)) product.images = [];
  basic.product = product;

  return JSON.stringify(basic);
}

/**
 * After an LLM suggests values for empty fields, merge them into `original`.
 * `scenes` and `characters` always stay exactly as in `original` (approved snapshot).
 * Non-empty strings and non-empty arrays in `original` are never overwritten.
 * `product.images` is only taken from `inferred` when `original` has no URLs.
 */
export function mergeContextInference(
  original: Record<string, unknown>,
  inferred: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original };
  out.scenes = original.scenes;
  out.characters = original.characters;

  function mergeNested(orig: Record<string, unknown>, inf: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const k of Object.keys(orig)) {
      const o = orig[k];
      const i = inf[k];
      if (k === "images" && Array.isArray(o)) {
        merged[k] = o.length > 0 ? o : Array.isArray(i) ? i : o;
        continue;
      }
      if (isPlainObject(o) && isPlainObject(i)) {
        merged[k] = mergeNested(o, i);
      } else if (typeof o === "string") {
        merged[k] = o.trim() !== "" ? o : typeof i === "string" ? i : o;
      } else if (Array.isArray(o)) {
        merged[k] = o.length > 0 ? o : Array.isArray(i) ? i : o;
      } else {
        merged[k] = i !== undefined ? i : o;
      }
    }
    return merged;
  }

  for (const key of Object.keys(original)) {
    if (key === "scenes" || key === "characters") continue;
    const o = original[key];
    const i = inferred[key];
    if (isPlainObject(o) && isPlainObject(i)) {
      out[key] = mergeNested(o, i);
    } else if (typeof o === "string") {
      out[key] = o.trim() !== "" ? o : typeof i === "string" ? i : o;
    } else if (Array.isArray(o)) {
      out[key] = o.length > 0 ? o : Array.isArray(i) ? i : o;
    }
  }
  return out;
}

/** True if any string field (except inside scenes / product.images) is empty — candidate for context fill. */
export function briefHasEmptyStringFields(brief: Record<string, unknown>): boolean {
  function walk(node: unknown, skipScenes: boolean): boolean {
    if (typeof node === "string") return node.trim() === "";
    if (!node || Array.isArray(node)) return false;
    if (!isPlainObject(node)) return false;
    for (const k of Object.keys(node)) {
      if (skipScenes && k === "scenes") continue;
      const child = node[k];
      if (k === "images" && Array.isArray(child)) continue;
      if (walk(child, skipScenes)) return true;
    }
    return false;
  }
  return walk(brief, true);
}

/** JSON string for keyframe context: scene list + indices. */
export function scenesJsonForKeyframes(briefJson: string): string {
  try {
    const p = JSON.parse(briefJson) as { scenes?: unknown[] };
    return JSON.stringify({ scenes: p.scenes ?? [] }, null, 2);
  } catch {
    return JSON.stringify({ scenes: [] });
  }
}
