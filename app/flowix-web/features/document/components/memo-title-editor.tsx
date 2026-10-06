import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, CSSProperties } from 'react';
import { CodeIcon, EyeIcon, EyeSlashIcon, PlusIcon, TextTIcon } from '@phosphor-icons/react';
import { Check } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { useMemoTitleSession, type RenameDocumentTitle } from './memo-title-session';
import { useSettingsStore } from '@/lib/store/settings-store';
import { windows } from '@platform/tauri/client';
import { readClipboardSnapshot, type ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { splitClipboardForTitlePaste } from '@features/editor/extensions/paste-rules/title-paste';
import { hasLeadingFrontmatter } from '@features/editor/extensions/paste-rules/markdown';
import { BlockActionMenu } from '@features/editor/components/drag-context-menu/block-action-menu';
import type { BlockMenuAction } from '@features/editor/components/drag-context-menu/block-menu-actions';
import type { DocumentEditorMode } from '@features/document/store/document-editor-view-store';
import { documentPropertyTargetId } from '@features/document/store/document-identity';
import { BUILTIN_PRESETS } from '@features/document/properties/presets';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';

interface MemoTitleEditorProps {
  displayId: string;
  filename: string;
  renameTitle: RenameDocumentTitle;
  editable: boolean;
  autoFocus?: boolean;
  /** Use a DOM selection surface when a host needs to avoid native textarea selection rendering. */
  useDocumentSelection?: boolean;
  /** Rich-text mode may navigate across the boundary while read-only. */
  allowReadOnlyBoundaryNavigation?: boolean;
  /** Whether to render the title's properties affordance. */
  showPropertiesToggle?: boolean;
  onMoveToBody: (request: MemoTitleBodyNavigation) => void;
  onPasteToBody?: (snapshot: ClipboardSnapshot) => void;
  editorMode?: DocumentEditorMode;
  onToggleEditorMode?: () => void;
}

export interface MemoTitleBodyNavigation {
  trailingContent?: string;
  insertEmptyLine: boolean;
}

export interface MemoTitleEditorHandle {
  focusEnd: () => void;
  appendBodyLine: (title: string) => Promise<boolean>;
}

export const MemoTitleEditor = forwardRef<MemoTitleEditorHandle, MemoTitleEditorProps>(function MemoTitleEditor({
  displayId,
  filename,
  renameTitle,
  editable,
  autoFocus = false,
  useDocumentSelection = false,
  allowReadOnlyBoundaryNavigation = false,
  showPropertiesToggle = true,
  onMoveToBody,
  onPasteToBody,
  editorMode = 'rich',
  onToggleEditorMode,
}: MemoTitleEditorProps, ref) {
  const { t } = useI18n();
  const propertiesVisible = useSettingsStore((state) => state.propertiesVisible);
  const togglePropertiesVisible = useSettingsStore((state) => state.togglePropertiesVisible);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const documentTitleRef = useRef<HTMLDivElement>(null);
  const propertiesMenuButtonRef = useRef<HTMLButtonElement>(null);
  const propertiesMenuRef = useRef<HTMLDivElement>(null);
  const documentTitleComposingRef = useRef(false);
  const bodyMergeRef = useRef<Promise<boolean> | null>(null);
  const [propertiesMenuOpen, setPropertiesMenuOpen] = useState(false);
  const [propertiesMenuPosition, setPropertiesMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [propertiesMenuIndex, setPropertiesMenuIndex] = useState(0);
  const [propertiesMenuInputMode, setPropertiesMenuInputMode] = useState<'mouse' | 'keyboard'>('mouse');
  /**
   * Canonical keys already present in the document frontmatter. Refreshed each
   * time the menu opens so presets that are already added can be disabled.
   */
  const [occupiedPropertyKeys, setOccupiedPropertyKeys] = useState<ReadonlySet<string>>(new Set());
  const session = useMemoTitleSession(displayId, filename, renameTitle);
  const { snapshot } = session;
  const titleInput = useComposingValue(
    snapshot.draft,
    (value) => session.setDraft(value.replace(/[\r\n]+/g, ' ')),
  );

  const closePropertiesMenu = useCallback(() => {
    setPropertiesMenuOpen(false);
    setPropertiesMenuPosition(null);
    setPropertiesMenuIndex(0);
    setPropertiesMenuInputMode('mouse');
  }, []);

  const openPropertiesMenu = useCallback(() => {
    const button = propertiesMenuButtonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setPropertiesMenuPosition({
      left: Math.max(8, rect.right + 8),
      top: Math.max(8, rect.top),
    });
    // Ask the editor which keys already exist before rendering the presets.
    // The frontmatter node view answers synchronously by filling this array.
    const keys: string[] = [];
    window.dispatchEvent(new CustomEvent('flowix:query-occupied-property-keys', {
      detail: { propertyTargetId: documentPropertyTargetId(displayId), keys },
    }));
    setOccupiedPropertyKeys(new Set(keys));
    setPropertiesMenuIndex(0);
    setPropertiesMenuInputMode('mouse');
    setPropertiesMenuOpen(true);
  }, [displayId]);

  /**
   * Preset rows offered under "添加属性". Sourced from `BUILTIN_PRESETS` so the
   * labels and YAML keys stay in lockstep with the properties dialog instead of
   * being duplicated here. `favorite` is excluded: pinning is already a
   * top-level action in this menu.
   *
   * Submenu rows are label-only — the presets' Phosphor icons are deliberately
   * omitted to keep the nested list visually quiet. `BlockMenuAction.icon`
   * stays required, so an explicit `null` is passed.
   *
   * Presets already present in the frontmatter are disabled, mirroring the
   * property row's own preset list, so a key cannot be added twice.
   */
  const propertyPresetMenuActions = useMemo<BlockMenuAction[]>(() => {
    const targetId = documentPropertyTargetId(displayId);
    return BUILTIN_PRESETS
      .filter((preset) => preset.category !== 'favorite')
      .map((preset) => {
        const taken = occupiedPropertyKeys.has(canonicalizePropertyKey(preset.key));
        return {
          id: `add-property-${preset.key}`,
          group: 'block',
          icon: null,
          label: t(preset.labelKey),
          disabled: taken,
          disabledReason: taken ? t('document.properties.commonKey.alreadyExists') : undefined,
          onSelect: () => {
            if (taken) return;
            window.dispatchEvent(new CustomEvent('flowix:add-property', {
              detail: { propertyTargetId: targetId, presetKey: preset.key },
            }));
            closePropertiesMenu();
          },
        };
      });
  }, [closePropertiesMenu, displayId, occupiedPropertyKeys, t]);

  const propertyMenuActions = useMemo<BlockMenuAction[]>(() => [
    {
      id: 'toggle-properties',
      group: 'block',
      icon: propertiesVisible ? <EyeSlashIcon size={16} weight="bold" /> : <EyeIcon size={16} weight="bold" />,
      label: t(propertiesVisible ? 'document.properties.hide' : 'document.properties.show'),
      trailingIcon: propertiesVisible ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : undefined,
      onSelect: () => {
        togglePropertiesVisible();
        closePropertiesMenu();
      },
    },
    {
      id: 'add-property',
      group: 'block',
      icon: <PlusIcon size={16} weight="bold" />,
      label: t('document.properties.add'),
      // Dual role: clicking the row adds a blank property, while hover /
      // ArrowRight reveals the preset panel beneath it.
      onSelect: () => {
        window.dispatchEvent(new CustomEvent('flowix:add-property', {
          detail: { propertyTargetId: documentPropertyTargetId(displayId) },
        }));
        closePropertiesMenu();
      },
      children: propertyPresetMenuActions,
      childrenGroupLabel: t('document.properties.preset'),
    },
    {
      id: 'property-presets',
      group: 'block',
      icon: <TextTIcon size={16} weight="bold" />,
      label: t('document.properties.presetProperties'),
      onSelect: () => {
        void windows.openPreferences('noteSettings');
        closePropertiesMenu();
      },
    },
    ...(onToggleEditorMode ? [{
      id: 'toggle-editor-mode',
      group: 'mode' as const,
      icon: <CodeIcon size={16} weight="bold" />,
      label: t(editorMode === 'source' ? 'document.action.richTextMode' : 'document.action.sourceMode'),
      onSelect: () => {
        onToggleEditorMode();
        closePropertiesMenu();
      },
    }] : []),
  ], [closePropertiesMenu, displayId, editorMode, onToggleEditorMode, propertiesVisible, propertyPresetMenuActions, t, togglePropertiesVisible]);

  const handlePropertiesMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      setPropertiesMenuInputMode('keyboard');
      const direction = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
      setPropertiesMenuIndex((index) => (index + direction + propertyMenuActions.length) % propertyMenuActions.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const action = propertyMenuActions[propertiesMenuIndex];
      // Disabled rows stay focusable but never activate.
      if (!action?.disabled) action?.onSelect();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePropertiesMenu();
    }
  };

  useEffect(() => {
    if (!propertiesMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (propertiesMenuButtonRef.current?.contains(target) || propertiesMenuRef.current?.contains(target)) return;
      closePropertiesMenu();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closePropertiesMenu();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closePropertiesMenu, propertiesMenuOpen]);

  useEffect(() => {
    if (!propertiesMenuOpen) return;
    const frameId = window.requestAnimationFrame(() => {
      propertiesMenuRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [propertiesMenuOpen]);

  const focusAt = useCallback((position: number) => {
    if (useDocumentSelection) {
      const element = documentTitleRef.current;
      if (!element) return;
      element.focus();
      const textNode = element.firstChild ?? element.appendChild(document.createTextNode(''));
      const caret = Math.max(0, Math.min(position, textNode.textContent?.length ?? 0));
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.setStart(textNode, caret);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    const caret = Math.max(0, Math.min(position, element.value.length));
    element.setSelectionRange(caret, caret);
  }, [useDocumentSelection]);

  const focusEnd = useCallback(() => {
    focusAt(useDocumentSelection
      ? (documentTitleRef.current?.textContent?.length ?? 0)
      : (textareaRef.current?.value.length ?? 0));
  }, [focusAt, useDocumentSelection]);

  const appendBodyLine = useCallback(async (title: string) => {
    if (bodyMergeRef.current) return bodyMergeRef.current;
    const currentTitle = useDocumentSelection
      ? (documentTitleRef.current?.textContent ?? snapshot.draft)
      : (textareaRef.current?.value ?? snapshot.draft);
    const caretPosition = currentTitle.length;
    session.setDraft(`${currentTitle}${title}`);
    const merge = session.commit({ expectBodyMutation: true }).then((saved) => {
      if (saved) requestAnimationFrame(() => focusAt(caretPosition));
      return saved;
    }).finally(() => {
      if (bodyMergeRef.current === merge) bodyMergeRef.current = null;
    });
    bodyMergeRef.current = merge;
    return merge;
  }, [focusAt, session, snapshot.draft, useDocumentSelection]);

  useImperativeHandle(ref, () => ({
    focusEnd,
    appendBodyLine,
  }), [appendBodyLine, focusEnd]);

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    if (useDocumentSelection) return;
    resizeTextarea();
  }, [resizeTextarea, titleInput.value, useDocumentSelection]);

  useLayoutEffect(() => {
    if (!useDocumentSelection || documentTitleComposingRef.current) return;
    const element = documentTitleRef.current;
    if (element && element.textContent !== snapshot.draft) {
      element.textContent = snapshot.draft;
    }
  }, [snapshot.draft, useDocumentSelection]);

  useLayoutEffect(() => {
    if (useDocumentSelection) return;
    const element = textareaRef.current;
    const widthRoot = element?.parentElement;
    if (!element || !widthRoot) return;

    let frame: number | null = null;
    const scheduleResize = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        resizeTextarea();
      });
    };

    // A narrower document column can wrap the same title onto additional
    // lines without changing the title draft. Observe the title shell so the
    // textarea is remeasured after the new width has been laid out.
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleResize);
    observer?.observe(widthRoot);
    window.addEventListener('resize', scheduleResize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', scheduleResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [resizeTextarea, useDocumentSelection]);

  useLayoutEffect(() => {
    if (!autoFocus || !editable) return;
    const element = useDocumentSelection ? documentTitleRef.current : textareaRef.current;
    if (!element) return;
    element.focus();
    if (useDocumentSelection) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      (element as HTMLTextAreaElement).select();
    }
  }, [autoFocus, displayId, editable, useDocumentSelection]);

  const getDocumentSelection = useCallback(() => {
    const element = documentTitleRef.current;
    const selection = window.getSelection();
    const value = element?.textContent ?? snapshot.draft;
    if (!element || !selection || selection.rangeCount === 0) {
      return { value, start: value.length, end: value.length };
    }
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
      return { value, start: value.length, end: value.length };
    }
    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(element);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = range.cloneRange();
    beforeEnd.selectNodeContents(element);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return {
      value,
      start: beforeStart.toString().length,
      end: beforeEnd.toString().length,
    };
  }, [snapshot.draft]);

  const getTitleSelection = useCallback(() => {
    if (useDocumentSelection) return getDocumentSelection();

    const element = textareaRef.current;
    const value = element?.value ?? snapshot.draft;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? start;
    return { value, start, end };
  }, [getDocumentSelection, snapshot.draft, useDocumentSelection]);

  const handleTitlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    if (!editable || documentTitleComposingRef.current) return;

    const data = event.clipboardData;
    if (!data) return;
    const snapshot = readClipboardSnapshot(data);
    if (hasLeadingFrontmatter(snapshot.markdown || snapshot.text)) {
      event.preventDefault();
      onPasteToBody?.(snapshot);
      return;
    }
    const split = splitClipboardForTitlePaste(snapshot);
    if (!split) return;

    const selection = getTitleSelection();
    const nextTitle = `${selection.value.slice(0, selection.start)}${split.titleLine}${selection.value.slice(selection.end)}`;

    event.preventDefault();
    session.setDraft(nextTitle);
    requestAnimationFrame(() => focusAt(selection.start + split.titleLine.length));
    if (split.body.text || split.body.html || split.body.files.length > 0) {
      onPasteToBody?.(split.body);
    }
  }, [editable, focusAt, getTitleSelection, onPasteToBody, session]);

  const handleDocumentTitleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (documentTitleComposingRef.current || titleInput.isComposingKeyboardEvent(event.nativeEvent)) return;
    const selection = getDocumentSelection();
    if ((event.key === 'ArrowDown' || event.key === 'ArrowRight')
      && selection.start === selection.value.length
      && selection.end === selection.value.length) {
      if (!editable && !allowReadOnlyBoundaryNavigation) return;
      event.preventDefault();
      if (!editable) {
        onMoveToBody({ insertEmptyLine: false });
        return;
      }
      void session.commit();
      onMoveToBody({ insertEmptyLine: false });
    } else if (!editable) {
      return;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const nextTitle = selection.value.slice(0, selection.start);
      const trailingContent = selection.value.slice(selection.end);
      session.setDraft(nextTitle);
      void session.commit({ expectBodyMutation: true });
      onMoveToBody({
        trailingContent,
        insertEmptyLine: true,
      });
    } else if (event.key === 'Escape') {
      session.cancel();
      event.currentTarget.blur();
    }
  }, [allowReadOnlyBoundaryNavigation, editable, getDocumentSelection, onMoveToBody, session, titleInput]);

  return (
    <div className="memo-title-shell">
      {showPropertiesToggle && (
        <button
          ref={propertiesMenuButtonRef}
          type="button"
          className="memo-title-properties-toggle"
          aria-label={t('document.properties.title')}
          title={t('document.properties.title')}
          aria-haspopup="menu"
          aria-expanded={propertiesMenuOpen}
          data-state={propertiesVisible ? 'visible' : 'hidden'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (propertiesMenuOpen) closePropertiesMenu();
            else openPropertiesMenu();
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M3 6H21V18H3V6ZM2 4C1.44772 4 1 4.44772 1 5V19C1 19.5523 1 20 2 20H22C22.5523 20 23 19.5523 23 19V5C23 4.44772 23 4 22 4H2ZM13 9H19V11H13V9ZM18 13H13V15H18V13ZM6 13H7V16H9V11H6V13ZM9 8H7V10H9V8Z" />
          </svg>
        </button>
      )}
      {propertiesMenuOpen && typeof document !== 'undefined' && createPortal(
        <BlockActionMenu
          actions={propertyMenuActions}
          selectedIndex={propertiesMenuIndex}
          mouseHoverEnabled={propertiesMenuInputMode === 'mouse'}
          menuRef={(node) => {
            propertiesMenuRef.current = node;
          }}
          style={{
            left: propertiesMenuPosition ? `${propertiesMenuPosition.left}px` : '-9999px',
            top: propertiesMenuPosition ? `${propertiesMenuPosition.top}px` : '-9999px',
            minWidth: 180,
          } satisfies CSSProperties}
          onHover={(index) => {
            setPropertiesMenuInputMode('mouse');
            setPropertiesMenuIndex(index);
          }}
          onKeyDown={handlePropertiesMenuKeyDown}
          ariaLabel={t('document.properties.title')}
        />,
        document.body,
      )}
      {useDocumentSelection ? (
        <div
          ref={documentTitleRef}
          role="textbox"
          aria-label={t('memo.untitled')}
          aria-multiline="false"
          aria-readonly={!editable}
          tabIndex={editable ? undefined : 0}
          contentEditable={editable ? 'plaintext-only' : false}
          suppressContentEditableWarning
          data-placeholder={t('memo.untitled')}
          className="memo-title-editor memo-title-editor--document-selection"
          onInput={(event) => {
            if (documentTitleComposingRef.current) return;
            session.setDraft((event.currentTarget.textContent ?? '').replace(/[\r\n]+/g, ' '));
          }}
          onCompositionStart={() => {
            documentTitleComposingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            documentTitleComposingRef.current = false;
            session.setDraft((event.currentTarget.textContent ?? '').replace(/[\r\n]+/g, ' '));
          }}
          onBlur={() => void session.commit()}
          onPaste={handleTitlePaste}
          onKeyDown={handleDocumentTitleKeyDown}
        />
      ) : (
      <textarea
        ref={textareaRef}
        rows={1}
        value={titleInput.value}
        readOnly={!editable}
        aria-label={t('memo.untitled')}
        placeholder={t('memo.untitled')}
        className="memo-title-editor"
        onChange={titleInput.onChange}
        onCompositionStart={titleInput.onCompositionStart}
        onCompositionEnd={titleInput.onCompositionEnd}
        onBlur={() => void session.commit()}
        onPaste={handleTitlePaste}
        onKeyDown={(event) => {
          if (titleInput.isComposingKeyboardEvent(event.nativeEvent)) return;
          if (
            (event.key === 'ArrowDown' || event.key === 'ArrowRight')
            && event.currentTarget.selectionStart === event.currentTarget.value.length
            && event.currentTarget.selectionEnd === event.currentTarget.value.length
          ) {
            if (!editable && !allowReadOnlyBoundaryNavigation) return;
            event.preventDefault();
            if (!editable) {
              onMoveToBody({ insertEmptyLine: false });
              return;
            }
            void session.commit();
            onMoveToBody({ insertEmptyLine: false });
          } else if (!editable) {
            return;
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const value = event.currentTarget.value;
            const selectionStart = event.currentTarget.selectionStart ?? snapshot.draft.length;
            const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
            const nextTitle = value.slice(0, selectionStart);
            const trailingContent = value.slice(selectionEnd);
            session.setDraft(nextTitle);
            void session.commit({ expectBodyMutation: true });
            onMoveToBody({
              trailingContent,
              insertEmptyLine: true,
            });
          } else if (event.key === 'Escape') {
            session.cancel();
            event.currentTarget.blur();
          }
        }}
      />
      )}
      {editable && snapshot.recoverableDraft != null && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            session.recoverDraft();
            requestAnimationFrame(focusEnd);
          }}
        >
          {t('document.save.recoverTitle')}
        </button>
      )}
    </div>
  );
});
