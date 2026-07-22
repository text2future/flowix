/**
 * Normalize an unknown thrown value into a user-displayable message.
 *
 * Prefer `error.message` when the value is an `Error`-shaped object; fall
 * back to `String(value)` so non-Error throws still render something useful
 * in toasts and inline error views.
 */
export function errorMessage(error: unknown): string {
  if (
    error
    && typeof error === 'object'
    && 'message' in error
    && typeof error.message === 'string'
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
