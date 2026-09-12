import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ChangeEvent,
  CompositionEvent,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { isImeKeyboardEvent } from "@/lib/input-method";

/**
 * IME-safe controlled value for `<input>` / `<textarea>`.
 *
 * Why: when an input is fully controlled (`value` + `onChange` writing back to
 * a store), Chinese/Japanese/Korean IMEs leave pinyin / hiragana / hangul
 * radicals in the field because every keystroke during composition fires
 * `onChange`, the store updates, and React re-renders the input to that
 * intermediate value. When the IME then commits a character, the DOM has
 * moved on but the controlled value is still the previous radical, so the
 * user sees "ni你" instead of "你".
 *
 * Fix: while composing, the hook keeps a local `draft` and surfaces it
 * instead of the parent's `controlledValue` — the input is effectively
 * uncontrolled during composition, letting the IME own the DOM. On
 * `compositionend`, the final value is committed to the parent once. The
 * returned keyboard predicate also combines the local composition lifecycle
 * with browser event signals so command keys can be ignored safely.
 *
 * Usage:
 * ```tsx
 * const { value, onChange, onCompositionStart, onCompositionEnd } =
 *   useComposingValue(settings.customInstruction, (next) =>
 *     updateSettings({ customInstruction: next })
 *   );
 *
 * <Textarea
 *   value={value}
 *   onChange={onChange}
 *   onCompositionStart={onCompositionStart}
 *   onCompositionEnd={onCompositionEnd}
 * />
 * ```
 */
export function useComposingValue(
  controlledValue: string,
  onCommit: (next: string) => void,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const composingRef = useRef(false);
  const committedCompositionValueRef = useRef<string | null>(null);
  // Keep the latest commit in a ref so compositionend doesn't capture a stale
  // closure of `onCommit` (which would skip the last keystroke if the parent
  // re-rendered between composition start and end).
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);

  const onChange = useCallback(
    (
      e: ChangeEvent<HTMLInputElement> | ChangeEvent<HTMLTextAreaElement>,
    ) => {
      if (composingRef.current) {
        // Mid-composition: follow the DOM but don't propagate to the store.
        setDraft(e.target.value);
      } else {
        // Some engines emit one final input/change event immediately after
        // compositionend. The final value was already committed there.
        if (committedCompositionValueRef.current === e.target.value) {
          committedCompositionValueRef.current = null;
          return;
        }
        committedCompositionValueRef.current = null;
        commitRef.current(e.target.value);
      }
    },
    [],
  );

  const onCompositionStart = useCallback(
    (
      e: CompositionEvent<HTMLInputElement> | CompositionEvent<HTMLTextAreaElement>,
    ) => {
      composingRef.current = true;
      committedCompositionValueRef.current = null;
      setDraft(e.currentTarget.value);
    },
    [],
  );

  const onCompositionEnd = useCallback(
    (
      e: CompositionEvent<HTMLInputElement> | CompositionEvent<HTMLTextAreaElement>,
    ) => {
      const next = e.currentTarget.value;
      composingRef.current = false;
      committedCompositionValueRef.current = next;
      setDraft(null);
      commitRef.current(next);
    },
    [],
  );

  const isComposingKeyboardEvent = useCallback((event: KeyboardEvent) => (
    isImeKeyboardEvent(event, composingRef.current)
  ), []);

  return {
    value: draft ?? controlledValue,
    onChange,
    onCompositionStart,
    onCompositionEnd,
    isComposingKeyboardEvent,
  } satisfies Pick<
    InputHTMLAttributes<HTMLInputElement> &
      TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange" | "onCompositionStart" | "onCompositionEnd"
  > & {
    isComposingKeyboardEvent: (event: KeyboardEvent) => boolean;
  };
}
