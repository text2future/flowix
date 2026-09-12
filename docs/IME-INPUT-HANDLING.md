---
key: im3k9xq2
---

# IME input handling

This document defines the frontend contract for Chinese, Japanese, Korean, and
other input method editors (IMEs). It applies to React inputs, native DOM
controllers, Tiptap, and CodeMirror integrations.

## State ownership

Text fields backed by business state have three distinct layers:

1. **Composition value** — an unconfirmed IME candidate owned locally by the
   input component.
2. **Confirmed draft** — text accepted by the IME and owned by the relevant
   feature session or store.
3. **Persisted value** — data confirmed by the backend or filesystem.

Composition values must not enter a business store, start an autosave timer,
rename a file, or update cross-feature paths. `compositionend` is the boundary
that promotes the final input value to a confirmed draft.

## Keyboard commands

Enter, Escape, Tab, arrow keys, and application shortcuts can also be consumed
by an IME. A feature must not execute a keyboard command while the event belongs
to composition.

Use `isImeKeyboardEvent` from `@/lib/input-method`. It combines:

- a locally tracked `compositionstart` / `compositionend` lifecycle;
- the standard `KeyboardEvent.isComposing` signal;
- process-key code `229`, required for WebKit and some native IMEs.

`keyCode` is deprecated for general keyboard handling. Code `229` is permitted
only inside this compatibility boundary. Feature code must not reproduce the
browser-specific expression.

## React input and textarea

Controlled React fields that write through to a store use
`useComposingValue` from `@shared/hooks/use-composing-value`. Bind its value,
change, and composition handlers to the field, and use its
`isComposingKeyboardEvent` predicate before handling command keys.

```tsx
const input = useComposingValue(value, updateConfirmedDraft);

<textarea
  value={input.value}
  onChange={input.onChange}
  onCompositionStart={input.onCompositionStart}
  onCompositionEnd={input.onCompositionEnd}
  onKeyDown={(event) => {
    if (input.isComposingKeyboardEvent(event.nativeEvent)) return;
    if (event.key === 'Enter') runEnterCommand();
  }}
/>
```

Do not put persistence in this shared hook. Debouncing, validation, rollback,
and backend writes remain responsibilities of the owning feature.

## Editor frameworks and native controllers

Tiptap and CodeMirror may expose their own composition state. Combine that
state with `isImeKeyboardEvent` before running commands. Native DOM controllers
track composition with a local boolean and pass it as the second argument.

Framework-owned document serialization must also pause during composition and
resume after `compositionend`; intermediate candidates are not document state.

## Required tests

Every input with command-key behavior covers:

- `isComposing=true`;
- `isComposing=false` with process-key `229`;
- a locally tracked composition lifecycle;
- ordinary command behavior after composition ends;
- no store write or autosave during composition;
- exactly one final confirmed value at `compositionend`.

Synthetic DOM tests verify application control flow but do not emulate a real
IME. Release checks for input-sensitive changes include macOS Tauri WebView and
Windows testing with Chinese Pinyin; Japanese and Korean input are included
when the affected component changes composition or selection behavior.
