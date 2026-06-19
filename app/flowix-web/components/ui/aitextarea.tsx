import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * Chat-composer variant of the shared textarea primitive.
 *
 * Differences from the form `Textarea`:
 * - `text-base` (16px) — chat messages read better at 16px
 * - `field-sizing-content` + `min-h-16` — auto-grows with content (the
 *   modern CSS `field-sizing-content` property; Chrome 123+ / Safari 17.4+
 *   fall back to a fixed 64px on older engines)
 * - Stronger disabled / invalid treatment — chat composer is interactive
 *   even in disabled mode, so the background is dimmed rather than hidden
 *
 * IME note: this is a pure passthrough. The "Chinese IME duplicates
 * characters" issue is a controlled-component problem at the consumer
 * site — see `textarea.tsx` for the `useComposingValue` pattern.
 */
const AITextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      data-slot="textarea"
      ref={ref}
      className={cn(
        "border-[var(--border)] placeholder:text-[var(--muted-foreground)] focus-visible:border-[var(--primary)] aria-invalid:border-[var(--destructive)] flex field-sizing-content min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
AITextarea.displayName = "AITextarea";

export { AITextarea };
