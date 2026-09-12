/**
 * Returns true when a keyboard event belongs to an active IME composition.
 *
 * `KeyboardEvent.isComposing` is the primary signal. WebKit and some native
 * IMEs can report false while Enter is confirming a candidate, but expose the
 * legacy process-key code 229 instead. Keep that compatibility detail at this
 * foundation boundary so feature code does not grow browser-specific checks.
 */
export function isImeKeyboardEvent(
  event: KeyboardEvent,
  locallyComposing = false,
): boolean {
  return locallyComposing || event.isComposing || event.keyCode === 229;
}
