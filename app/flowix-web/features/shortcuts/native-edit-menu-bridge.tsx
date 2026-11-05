'use client';

import { useEffect } from 'react';
import { getAction } from '@/lib/shortcuts/registry';
import { getPlatform } from '@/lib/shortcuts/platform';
import { subscribe } from '@platform/tauri/event-bus';
import { invoke } from '@platform/tauri/core';
import { createLogger } from '@/lib/logger';
import { NATIVE_CLIPBOARD_ACTION_EVENT, type NativeClipboardAction } from '@shared/clipboard/native-clipboard-action';

const SELECT_ALL_EVENT = 'flowix://editor-select-all';
const UNDO_EVENT = 'flowix://editor-undo';
const REDO_EVENT = 'flowix://editor-redo';
const log = createLogger('native-edit-menu');

function runClipboardAction(action: NativeClipboardAction): void {
  const event = new CustomEvent(NATIVE_CLIPBOARD_ACTION_EVENT, { cancelable: true, detail: action });
  if (!document.dispatchEvent(event)) return;
  void invoke('perform_native_clipboard_action', { action }).catch(error => log.warn('native clipboard action failed', { action, error }));
}

function selectFocusedNativeField(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    focused.select();
    return true;
  }
  return false;
}

function runNativeEditCommand(command: 'undo' | 'redo'): boolean {
  const focused = document.activeElement;
  const isNativeTextField = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement;
  const isContentEditableTitle = focused instanceof HTMLElement
    && focused.isContentEditable
    && focused.closest('.memo-title-editor--document-selection') !== null;
  if (!isNativeTextField && !isContentEditableTitle) {
    return false;
  }
  if (typeof document.execCommand !== 'function') return false;
  return document.execCommand(command);
}

function runEditorAction(actionId: 'editor.undo' | 'editor.redo'): void {
  const action = getAction(actionId);
  if (!action) return;
  void action.run({ scope: 'editor', source: 'menu', platform: getPlatform() });
}

/** Routes native edit-menu accelerators that macOS consumes before the DOM. */
export function NativeEditMenuBridge() {
  useEffect(() => {
    const unsubscribes = [
      subscribe('flowix://clipboard-cut', () => runClipboardAction('cut')),
      subscribe('flowix://clipboard-copy', () => runClipboardAction('copy')),
      subscribe('flowix://clipboard-paste', () => runClipboardAction('paste')),
      subscribe(SELECT_ALL_EVENT, () => {
        if (selectFocusedNativeField()) return;
        const action = getAction('editor.selectAll');
        if (!action) return;
        void action.run({ scope: 'editor', source: 'menu', platform: getPlatform() });
      }),
      subscribe(UNDO_EVENT, () => {
        if (!runNativeEditCommand('undo')) runEditorAction('editor.undo');
      }),
      subscribe(REDO_EVENT, () => {
        if (!runNativeEditCommand('redo')) runEditorAction('editor.redo');
      }),
    ];
    return () => unsubscribes.forEach(unsubscribe => unsubscribe());
  }, []);

  return null;
}
