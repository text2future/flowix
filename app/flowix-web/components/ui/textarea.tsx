import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * shadcn-style Textarea passthrough. Multi-line text input for forms.
 *
 * IME note: this is a pure passthrough and intentionally does NOT swallow
 * `onChange` / `composition*` events. Chinese IME duplication is a
 * controlled-component problem at the consumer site — fix it with the
 * `useComposingValue` pattern (example below), not by adding composition
 * logic here.
 *
 * @example IME-safe usage
 * ```tsx
 * const [value, setValue] = useState("");
 * const [draft, setDraft] = useState<string | null>(null);
 *
 * <Textarea
 *   value={draft ?? value}                  // uncontrolled while composing
 *   onChange={(e) => setDraft(e.target.value)}
 *   onCompositionStart={() => setDraft((d) => d ?? "")}
 *   onCompositionEnd={(e) => {
 *     const next = e.currentTarget.value;
 *     setDraft(null);
 *     setValue(next);                        // commit once
 *   }}
 * />
 * ```
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      data-slot="textarea"
      ref={ref}
      className={cn(
        "border-[var(--border)] placeholder:text-[var(--muted-foreground)] focus-visible:border-[var(--primary)] focus-visible:ring-0 aria-invalid:border-[var(--destructive)] flex min-h-[80px] w-full rounded-lg border bg-transparent px-3 py-2 text-sm transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
