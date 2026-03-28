# Tool Schemas

> **Source:** `src/server/services/gemini.ts`
>
> All tool definitions passed to Gemini as function declarations.

---

## Discovery Phase Tools

### update_draft_brief

Merge factual updates into the session draft. When the user states new facts, call with patch_json: a JSON string of a partial brief, e.g. `{"brand":{"name":"Acme"}}`.

```json
{
  "name": "update_draft_brief",
  "parameters": {
    "type": "object",
    "properties": {
      "patch_json": {
        "type": "string",
        "description": "Stringified JSON object; only keys the user just clarified."
      }
    },
    "required": ["patch_json"]
  }
}
```

### commit_script_version

Save one approved version to the storyboard. ONLY after the user confirmed BOTH the full scene list (≤5) AND the full cast (≤3).

```json
{
  "name": "commit_script_version",
  "parameters": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "description": "Version label e.g. 'v1 — first lock'"
      },
      "scenes": {
        "type": "array",
        "maxItems": 5,
        "items": {
          "type": "object",
          "properties": {
            "scene_number": { "type": "number" },
            "start_time": { "type": "number" },
            "end_time": { "type": "number" },
            "visual_description": { "type": "string" },
            "camerashot_type": { "type": "string" }
          },
          "required": ["scene_number", "start_time", "end_time", "visual_description", "camerashot_type"]
        }
      },
      "characters": {
        "type": "object",
        "properties": {
          "talent_type": { "type": "string" },
          "cast": {
            "type": "array",
            "maxItems": 3,
            "items": {
              "type": "object",
              "properties": {
                "role": { "type": "string" },
                "description": { "type": "string" }
              },
              "required": ["role", "description"]
            }
          }
        },
        "required": ["talent_type", "cast"]
      }
    },
    "required": ["label", "scenes", "characters"]
  }
}
```

---

## Keyframe Phase Tools

### generate_character

Generate a reference image for a character in the ad. Call this before generating keyframes that include this character.

```json
{
  "name": "generate_character",
  "parameters": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Character name/role, e.g. 'protagonist', 'the mom', 'barista'"
      },
      "visualPrompt": {
        "type": "string",
        "description": "Detailed visual description for the character reference image. Include age, ethnicity, build, clothing, hairstyle, expression, and pose. MUST specify a frontal/front-facing pose against a plain solid-color or transparent background for compositing into keyframes. No environmental backgrounds."
      },
      "id": {
        "type": "string",
        "description": "Existing character asset ID. If provided, creates a new version of this character instead of a new character. Omit for brand-new characters."
      }
    },
    "required": ["name", "visualPrompt"]
  }
}
```

### generate_keyframe

Generate a start or end keyframe image for a specific scene. Reference character images are attached automatically when characterIds are provided — describe the scene and action, not the character's appearance.

```json
{
  "name": "generate_keyframe",
  "parameters": {
    "type": "object",
    "properties": {
      "beatIndex": {
        "type": "number",
        "description": "Scene index (0-based) from the approved scene list"
      },
      "keyframeType": {
        "type": "string",
        "enum": ["start", "end"],
        "description": "Whether this is the start or end keyframe for the scene"
      },
      "label": {
        "type": "string",
        "description": "Label in the format scene_[N]_start or scene_[N]_end"
      },
      "visualPrompt": {
        "type": "string",
        "description": "Detailed visual prompt for the scene. Include camera angle, lighting, composition, setting, and action. Refer to characters as 'the character shown in the attached reference image' — do not re-describe their appearance. Be cinematic and specific."
      },
      "characterIds": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Asset IDs of characters in this scene. MANDATORY when the scene includes characters — pass an empty array if no characters are present."
      },
      "includeProductImage": {
        "type": "boolean",
        "description": "Whether to include the uploaded product image as a reference"
      }
    },
    "required": ["beatIndex", "keyframeType", "label", "visualPrompt", "characterIds"]
  }
}
```

---

## Nano Banana (Image Generation)

> **Source:** `src/server/services/nano-banana.ts` — `generateImage()`
>
> Not a Gemini tool declaration, but the prompt structure sent to `gemini-2.5-flash-image`.

The `contents` array sent to the image model is constructed as:

1. `{ text: visualPrompt }` — the scene/character description
2. When labeled character refs are present, a compositing instruction: `"IMPORTANT: The attached reference images show the exact characters to use in this scene. Reproduce their appearance faithfully — same face, hair, clothing, and build. Do not invent new character appearances."`
3. For each labeled character ref: `{ text: "Reference image for character '${label}':" }` then `{ inlineData: base64 image }`
4. For each unlabeled ref (product image): `{ inlineData: base64 image }`

The prompt suffix appended to character generation prompts (in `chat/route.ts`):

> Front-facing view, centered subject, plain solid-color or transparent background, studio lighting. Full body or three-quarter shot suitable for compositing.
