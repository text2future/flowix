import type { ChatMessage } from "@/types";
import type { AgentMessageAttachment, AgentTypeKey } from "@/types/agent";

const STORAGE_KEY = "flowix-agent-inline-image-presentations-v2";
const LEGACY_STORAGE_KEY = "flowix-agent-inline-image-presentations-v1";
const MAX_PRESENTATIONS = 3000;

interface InlineImageMarker {
  offset: number;
  order: number;
  label: string;
  path: string;
}

interface InlineImagePresentation {
  threadId: string;
  agentType: AgentTypeKey;
  fingerprint: string;
  legacyFingerprint?: string;
  createdAt: number;
  markers: InlineImageMarker[];
  attachments: AgentMessageAttachment[];
}

const IMAGE_LINK_RE = /\[((?:\\.|[^\]])*)\]\((flowix:\/\/agent-image-attachment\?[^)\s]+)\)/gu;

function readPresentations(): InlineImagePresentation[] {
  try {
    const current = parsePresentationArray(globalThis.localStorage?.getItem(STORAGE_KEY))
      .filter(isPresentation);
    const legacy = parsePresentationArray(globalThis.localStorage?.getItem(LEGACY_STORAGE_KEY))
      .filter(isLegacyPresentation)
      .map((item): InlineImagePresentation => ({
        ...item,
        fingerprint: "",
        legacyFingerprint: item.fingerprint,
        attachments: imageAttachmentsFromMarkers(item.markers),
      }));
    const seen = new Set<string>();
    return [...current, ...legacy].filter((item) => {
      const key = `${item.threadId}\u0000${item.agentType}\u0000${item.createdAt}\u0000${item.legacyFingerprint ?? item.fingerprint}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

function parsePresentationArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isPresentation(value: unknown): value is InlineImagePresentation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InlineImagePresentation>;
  return typeof candidate.threadId === "string" &&
    typeof candidate.agentType === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.createdAt === "number" &&
    Array.isArray(candidate.markers) &&
    candidate.markers.every((marker) =>
      !!marker && typeof marker.offset === "number" && typeof marker.order === "number" &&
      typeof marker.label === "string" && typeof marker.path === "string",
    ) && Array.isArray(candidate.attachments) && candidate.attachments.every((attachment) =>
      !!attachment && typeof attachment.path === "string" &&
      typeof attachment.name === "string" && typeof attachment.mimeType === "string" &&
      (attachment.type === "input_image" || attachment.type === "input_file"),
    );
}

function isLegacyPresentation(value: unknown): value is Omit<InlineImagePresentation, "attachments"> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InlineImagePresentation>;
  return typeof candidate.threadId === "string" &&
    typeof candidate.agentType === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.createdAt === "number" &&
    Array.isArray(candidate.markers) &&
    candidate.markers.every((marker) =>
      !!marker && typeof marker.offset === "number" && typeof marker.order === "number" &&
      typeof marker.label === "string" && typeof marker.path === "string",
    ) && !Array.isArray(candidate.attachments);
}

function imageAttachmentsFromMarkers(markers: InlineImageMarker[]): AgentMessageAttachment[] {
  const seen = new Set<string>();
  return markers.flatMap((marker) => {
    if (!marker.path || seen.has(marker.path)) return [];
    seen.add(marker.path);
    const extension = marker.path.split(/[\\/.]/u).pop()?.toLowerCase();
    const mimeType = extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "webp" ? "image/webp"
        : extension === "gif" ? "image/gif" : "image/png";
    return [{
      type: "input_image",
      path: marker.path,
      name: marker.label || marker.path.split(/[\\/]/u).pop() || "Image",
      mimeType,
      detail: "high",
    }];
  });
}

function writePresentations(presentations: InlineImagePresentation[]): void {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify(presentations.slice(-MAX_PRESENTATIONS)),
    );
  } catch {
    // Presentation hints are best effort; provider history remains available.
  }
}

function normalizeText(content: string): string {
  return content.replace(/\r\n/gu, "\n").trim();
}

function isImageAttachment(attachment: AgentMessageAttachment): boolean {
  return attachment.type === "input_image" || attachment.mimeType.toLowerCase().startsWith("image/");
}

function fingerprint(content: string): string {
  const value = normalizeText(content);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${first >>> 0}:${second >>> 0}`;
}

function legacyFingerprint(
  content: string,
  attachments: readonly AgentMessageAttachment[] | undefined,
): string {
  const paths = (attachments ?? []).filter(isImageAttachment).map(({ path }) => path).sort();
  const value = JSON.stringify([normalizeText(content), paths]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${first >>> 0}:${second >>> 0}`;
}

function unescapeLabel(label: string): string {
  return label.replace(/\\([\\[\]])/gu, "$1");
}

function captureMarkers(
  content: string,
  displayContent: string,
  attachments: readonly AgentMessageAttachment[],
): InlineImageMarker[] {
  const markers: InlineImageMarker[] = [];
  let cursor = 0;
  let plainText = "";
  let match: RegExpExecArray | null;
  IMAGE_LINK_RE.lastIndex = 0;
  while ((match = IMAGE_LINK_RE.exec(displayContent))) {
    plainText += displayContent.slice(cursor, match.index);
    try {
      const url = new URL(match[2]);
      const path = url.searchParams.get("path");
      if (
        url.protocol === "flowix:" && url.hostname === "agent-image-attachment" && path &&
        attachments.some((attachment) => attachment.path === path && isImageAttachment(attachment))
      ) {
        markers.push({
          offset: plainText.length,
          order: markers.length,
          label: unescapeLabel(match[1]),
          path,
        });
      }
    } catch {
      // Ignore malformed internal links.
    }
    cursor = IMAGE_LINK_RE.lastIndex;
  }
  plainText += displayContent.slice(cursor);
  return markers.length > 0 && normalizeText(plainText) === normalizeText(content)
    ? markers
    : [];
}

/** Persist image marker positions and local image paths, not a second copy of the user text. */
export function saveInlineImagePresentation(
  threadId: string,
  agentType: AgentTypeKey,
  content: string,
  displayContent: string,
  attachments: readonly AgentMessageAttachment[] | undefined,
  createdAt: number,
): void {
  if (!threadId || !attachments?.length) return;
  const markers = captureMarkers(content, displayContent, attachments);
  if (markers.length === 0) return;
  const presentations = readPresentations().filter((item) =>
    !(item.threadId === threadId && item.agentType === agentType &&
      item.fingerprint === fingerprint(content) && item.createdAt === createdAt),
  );
  presentations.push({
    threadId,
    agentType,
    fingerprint: fingerprint(content),
    createdAt,
    markers,
    attachments: attachments.filter(isImageAttachment).map((attachment) => ({ ...attachment })),
  });
  writePresentations(presentations);
}

function restoreContent(
  content: string,
  markers: InlineImageMarker[],
  attachments: readonly AgentMessageAttachment[],
): string {
  const validMarkers = markers.filter((marker) =>
    attachments.some((attachment) => attachment.path === marker.path &&
      isImageAttachment(attachment)),
  );
  return validMarkers
    .slice()
    .sort((left, right) => right.offset - left.offset || right.order - left.order)
    .reduce((restored, marker) => {
      const offset = Math.max(0, Math.min(marker.offset, restored.length));
      const label = marker.label.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
      const href = `flowix://agent-image-attachment?path=${encodeURIComponent(marker.path)}`;
      return `${restored.slice(0, offset)}[${label}](${href})${restored.slice(offset)}`;
    }, content);
}

function withoutImageLinks(content: string): string {
  IMAGE_LINK_RE.lastIndex = 0;
  return content.replace(IMAGE_LINK_RE, "");
}

function mergeRestoredAttachments(
  historyAttachments: readonly AgentMessageAttachment[] | undefined,
  savedAttachments: readonly AgentMessageAttachment[],
): AgentMessageAttachment[] {
  const nonImages = (historyAttachments ?? []).filter((attachment) => !isImageAttachment(attachment));
  // The saved input paths are the paths Flowix can read from its attachment
  // cache. Provider history may omit them or replace them with provider-owned
  // paths, so prefer the original local image attachments when available.
  const images = savedAttachments.length > 0
    ? savedAttachments.filter(isImageAttachment)
    : (historyAttachments ?? []).filter(isImageAttachment);
  return [...nonImages, ...images];
}

/** Restore inline cards on provider-history rows after a cold refresh. */
export function restoreInlineImagePresentations(
  threadId: string,
  agentType: AgentTypeKey,
  messages: ChatMessage[],
): ChatMessage[] {
  if (!threadId || messages.length === 0) return messages;
  const available = readPresentations().filter((item) =>
    item.threadId === threadId && item.agentType === agentType,
  );

  let changed = false;
  const restored = messages.map((message) => {
    if (message.role !== "user") return message;
    const plainContent = withoutImageLinks(message.content);
    const key = fingerprint(plainContent);
    const timestamp = Date.parse(message.timestamp);
    const exactCandidates = available
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.fingerprint === key ||
        (item.legacyFingerprint && item.legacyFingerprint === legacyFingerprint(plainContent, message.attachments)));
    const candidates = exactCandidates.length > 0 || !Number.isFinite(timestamp)
      ? exactCandidates
      : available
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.legacyFingerprint && Math.abs(item.createdAt - timestamp) <= 30_000);
    let markers: InlineImageMarker[] = [];
    let savedAttachments: AgentMessageAttachment[] = [];
    if (candidates.length > 0) {
      const nearest = candidates.reduce((best, candidate) => {
        if (!Number.isFinite(timestamp)) return candidate.item.createdAt > best.item.createdAt ? candidate : best;
        return Math.abs(candidate.item.createdAt - timestamp) < Math.abs(best.item.createdAt - timestamp)
          ? candidate
          : best;
      });
      available.splice(nearest.index, 1);
      markers = nearest.item.markers;
      savedAttachments = nearest.item.attachments;
    } else if (message.attachments?.length && !message.content.includes("flowix://agent-image-attachment")) {
      // Older messages predate the saved position metadata; keep their cards
      // visible at the start of the text while preserving image order.
      markers = message.attachments.filter(isImageAttachment).map((attachment, order) => ({
        offset: 0,
        order,
        label: attachment.name,
        path: attachment.path,
      }));
    }
    const attachments = mergeRestoredAttachments(message.attachments, savedAttachments);
    const content = message.content.includes("flowix://agent-image-attachment")
      ? message.content
      : restoreContent(message.content, markers, attachments);
    if (content === message.content && attachments.length === (message.attachments?.length ?? 0)) return message;
    changed = true;
    return { ...message, content, attachments: attachments.length > 0 ? attachments : undefined };
  });
  return changed ? restored : messages;
}
