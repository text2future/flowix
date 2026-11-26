import { agent } from "@platform/tauri/client";

const pendingCachedAttachmentReads = new Map<string, Promise<string | null>>();

export function readCachedAttachmentPreview(path: string): Promise<string | null> {
  const pending = pendingCachedAttachmentReads.get(path);
  if (pending) return pending;
  const request = agent.readCachedAttachment(path);
  pendingCachedAttachmentReads.set(path, request);
  void request.then(
    () => {
      if (pendingCachedAttachmentReads.get(path) === request) pendingCachedAttachmentReads.delete(path);
    },
    () => {
      if (pendingCachedAttachmentReads.get(path) === request) pendingCachedAttachmentReads.delete(path);
    },
  );
  return request;
}

