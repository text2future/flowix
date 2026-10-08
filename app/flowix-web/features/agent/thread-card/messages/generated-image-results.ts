export type GeneratedImageSource =
  | { kind: "url" | "data"; value: string }
  | { kind: "file"; value: string };

const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif|tiff?)$/i;
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|tiff?);base64,/i;
const IMAGE_URL_RE = /^https?:\/\//i;
const IMAGE_PATH_RE = /(?:^|[\s"'`])((?:\/|[a-z]:[\\/]|\.{1,2}[\\/])[^"'`<>|\r\n]*?\.(?:png|jpe?g|gif|webp|bmp|avif|tiff?))(?:[\s"'`<>]|$)/giu;

function addSource(
  source: GeneratedImageSource,
  output: GeneratedImageSource[],
  seen: Set<string>,
): void {
  const key = `${source.kind}:${source.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push(source);
}

function addString(
  value: string,
  key: string,
  output: GeneratedImageSource[],
  seen: Set<string>,
): void {
  const trimmed = value.trim();
  const normalizedKey = key.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
  if (!trimmed) return;
  if (IMAGE_DATA_URL_RE.test(trimmed)) {
    addSource({ kind: "data", value: trimmed }, output, seen);
    return;
  }

  if (IMAGE_URL_RE.test(trimmed) && /^(?:url|src|uri|image_url)$/u.test(normalizedKey)) {
    addSource({ kind: "url", value: trimmed }, output, seen);
    return;
  }

  if (/^(?:file_path|image_path|output_path|saved_path|path|filename|file)$/u.test(normalizedKey)) {
    const path = trimmed.startsWith("file://")
      ? decodeFileUrl(trimmed)
      : trimmed;
    if (IMAGE_EXTENSION_RE.test(path)) {
      addSource({ kind: "file", value: path }, output, seen);
      return;
    }
  }

  // Codex can return a sentence such as “Image saved to /…/generated.png”
  // instead of a structured path field. Read only image-looking paths from
  // result/output text, never arbitrary paths from the rest of the event.
  if (/^(?:result|output|content|message)$/u.test(normalizedKey)) {
    IMAGE_PATH_RE.lastIndex = 0;
    for (const match of trimmed.matchAll(IMAGE_PATH_RE)) {
      const path = match[1].replace(/[.,;:!?]+$/u, "");
      if (IMAGE_EXTENSION_RE.test(path)) {
        addSource({ kind: "file", value: path }, output, seen);
      }
    }
    const barePath = trimmed.replace(/^['"`]|['"`]$/g, "");
    if (IMAGE_EXTENSION_RE.test(barePath) && !/\s/u.test(barePath)) {
      addSource({ kind: "file", value: barePath }, output, seen);
    }
  }
}

function decodeFileUrl(value: string): string {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname);
  } catch {
    return value;
  }
}

function walkResult(
  value: unknown,
  key: string,
  output: GeneratedImageSource[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    addString(value, key, output, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkResult(item, key, output, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const base64 = record.b64_json ?? record.b64Json;
  if (typeof base64 === "string" && /^[a-z0-9+/]+=*$/i.test(base64)) {
    const mime = typeof record.mime_type === "string"
      ? record.mime_type
      : typeof record.mimeType === "string"
        ? record.mimeType
        : "image/png";
    if (/^image\/(?:png|jpeg|gif|webp|bmp|avif)$/i.test(mime)) {
      addSource({ kind: "data", value: `data:${mime};base64,${base64}` }, output, seen);
    }
  }
  for (const [childKey, child] of Object.entries(record)) {
    walkResult(child, childKey, output, seen, depth + 1);
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function extractGeneratedImageSources(
  message: {
    toolData?: string;
    toolInput?: Record<string, unknown>;
    toolCall?: Record<string, unknown>;
    toolResult?: Record<string, unknown>;
    content?: string;
  },
): GeneratedImageSource[] {
  const output: GeneratedImageSource[] = [];
  const seen = new Set<string>();
  walkResult(parseJson(message.toolData), "toolData", output, seen, 0);
  walkResult(message.toolResult, "toolResult", output, seen, 0);
  walkResult(message.toolInput, "toolInput", output, seen, 0);
  walkResult(message.toolCall, "toolCall", output, seen, 0);
  walkResult(message.content, "content", output, seen, 0);
  return output;
}
