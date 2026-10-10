export const SAFE_LINK_PROTOCOLS: ReadonlySet<string> = new Set([
  "http",
  "https",
  "file",
  "tauri",
  "flowix",
  "mailto",
  "tel",
]);

/**
 * Validate an href before it reaches either the DOM or the OS opener.
 *
 * The compact form is only used for protocol detection. Keeping the original
 * value preserves paths and URLs while still rejecting control-character
 * variants such as `java\nscript:`.
 */
export function sanitizeLinkHref(
  rawHref: string | null | undefined,
): string | null {
  const href = rawHref?.trim() ?? "";
  if (!href) return null;
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;

  // Windows drive paths have a colon but are not URI schemes.
  if (href.startsWith("/") || /^[a-z]:[\\/]/i.test(href)) return href;

  const compact = href.replace(/[\u0000-\u0020\u007f]/g, "");
  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1].toLowerCase();
  if (protocol && !SAFE_LINK_PROTOCOLS.has(protocol)) return null;

  // `tauri://localhost` is the desktop webview's own origin. It is used by
  // agent output for local file locations, but arbitrary Tauri hosts should
  // not be forwarded to a renderer or the OS opener.
  if (protocol === "tauri") {
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "tauri:" || parsed.hostname.toLowerCase() !== "localhost") {
        return null;
      }
    } catch {
      return null;
    }
  }

  return href;
}
