/** Cancel this event only when an application surface owns the clipboard action. */
export const NATIVE_CLIPBOARD_ACTION_EVENT = 'flowix:native-clipboard-action';
export type NativeClipboardAction = 'cut' | 'copy' | 'paste';
