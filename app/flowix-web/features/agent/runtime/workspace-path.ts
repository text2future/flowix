/**
 * Normalize a workspace path without importing stores or UI modules.
 *
 * Runtime workspace resolution is used by pure unit tests and low-level
 * configuration code, so this helper must remain free of application startup
 * side effects such as Tauri event subscriptions.
 */
export function normalizeWorkspacePath(
  path: string | null | undefined,
): string {
  return (path ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/[\\/]+$/, "");
}
