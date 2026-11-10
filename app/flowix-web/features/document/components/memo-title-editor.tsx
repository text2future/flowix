import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PlusIcon, SmileyIcon } from '@phosphor-icons/react';
import { MousePointerClick } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const logger = createLogger('memo-title-editor');
import { Tooltip } from '@shared/ui/tooltip';
import { ADDABLE_TABLE_PROPERTY_KINDS, getPropertyTypeDefinition } from '@/lib/property-types';
import { createPropertyId, createPropertyOptionId } from '@/lib/property-identity';
import { Popover, PopoverContent } from '@shared/ui/popover';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { useMemoTitleSession, type RenameDocumentTitle } from './memo-title-session';
import { TableFieldEditorForm } from '@features/multidimensional-table/table-field-header';
import type { TableFieldOption, TableFieldType } from '@features/multidimensional-table/model';
import { useSettingsStore } from '@/lib/store/settings-store';
import { windows } from '@platform/tauri/client';
import { readClipboardSnapshot, type ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { splitClipboardForTitlePaste } from '@features/editor/extensions/paste-rules/title-paste';
import { hasLeadingFrontmatter } from '@features/editor/extensions/paste-rules/markdown';
import { documentPropertyTargetId } from '@features/document/store/document-identity';
import { getAllPresets } from '@features/document/properties/presets';
import { PropertyPresetMenu } from './property-preset-menu';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { getPropertyPresets, usePropertyPresets } from '@features/properties/public-api';
import { savePropertyPreset, usePropertyPresetStore } from '@features/properties/property-preset-store';
import { SYSTEM_FRONTMATTER_KEYS } from '@features/document/properties/frontmatter-model';
import { PropertyIconPickerPanel } from '@features/document/properties/icon-picker-panel';
import { setDocumentProperties } from '@features/document/public/path-properties';
import { useNotebookNoteIcon } from '@features/memo/public/shell-api';
import type { WorkspaceColumnId } from '@features/workspace/public/host-api';

type EditorAddablePropertyType = Exclude<TableFieldType, 'primary' | 'Note'>;

interface MemoTitleEditorProps {
  displayId: string;
  filename: string;
  /** Absolute note path; drives the note icon entry in the property actions bar. */
  filePath?: string;
  renameTitle: RenameDocumentTitle;
  editable: boolean;
  propertyActionsEnabled?: boolean;
  workspaceHost?: WorkspaceColumnId;
  onActivateProperties?: () => void;
  autoFocus?: boolean;
  /** Use a DOM selection surface when a host needs to avoid native textarea selection rendering. */
  useDocumentSelection?: boolean;
  /** Rich-text mode may navigate across the boundary while read-only. */
  allowReadOnlyBoundaryNavigation?: boolean;
  /** Whether to render the title's properties affordance. */
  showPropertiesToggle?: boolean;
  /** The associated property list is currently under the pointer. */
  propertyAreaHovered?: boolean;
  onMoveToBody: (request: MemoTitleBodyNavigation) => void;
  onPasteToBody?: (snapshot: ClipboardSnapshot) => void;
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
  filePath,
  renameTitle,
  editable,
  propertyActionsEnabled = editable,
  workspaceHost,
  onActivateProperties,
  autoFocus = false,
  useDocumentSelection = false,
  allowReadOnlyBoundaryNavigation = false,
  showPropertiesToggle = true,
  propertyAreaHovered = false,
  onMoveToBody,
  onPasteToBody,
}: MemoTitleEditorProps, ref) {
  const { t } = useI18n();
  const { fields: propertyFields } = usePropertyPresets();
  const propertiesVisible = useSettingsStore((state) => state.propertiesVisible);
  const togglePropertiesVisible = useSettingsStore((state) => state.togglePropertiesVisible);
  const handleTogglePropertiesVisible = useCallback(() => {
    const opening = !useSettingsStore.getState().propertiesVisible;
    togglePropertiesVisible();
    if (opening) toast.success(t('document.properties.openedToast'));
  }, [t, togglePropertiesVisible]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const documentTitleRef = useRef<HTMLDivElement>(null);
  const documentTitleComposingRef = useRef(false);
  const bodyMergeRef = useRef<Promise<boolean> | null>(null);
  const [propertyPickerOpen, setPropertyPickerOpen] = useState(false);
  const [propertyPickerAnchorRect, setPropertyPickerAnchorRect] = useState<DOMRect | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconPickerAnchorRect, setIconPickerAnchorRect] = useState<DOMRect | null>(null);
  const [addPropertyOpen, setAddPropertyOpen] = useState(false);
  const [addPropertyAnchorRect, setAddPropertyAnchorRect] = useState<DOMRect | null>(null);
  const [addPropertyName, setAddPropertyName] = useState('');
  const [addPropertyType, setAddPropertyType] = useState<EditorAddablePropertyType>('Text');
  const [addPropertyOptions, setAddPropertyOptions] = useState<TableFieldOption[]>([]);
  const [addPropertyTypeMenuOpen, setAddPropertyTypeMenuOpen] = useState(false);
  /**
   * Canonical keys already present in the document frontmatter. Refreshed each
   * time the menu opens so the picker can show their selected state.
   */
  const [occupiedPropertyKeys, setOccupiedPropertyKeys] = useState<ReadonlySet<string>>(new Set());
  const session = useMemoTitleSession(displayId, filename, renameTitle);
  const propertyTargetId = documentPropertyTargetId(displayId, workspaceHost);
  const documentPropertyPresets = useMemo(() => {
    const presets = getAllPresets(propertyFields, (key) => t(key));
    return {
      system: presets.filter((preset) => preset.source === 'builtin' && preset.key !== 'flowix_favorited'),
      custom: presets.filter((preset) => preset.source === 'custom'),
    };
  }, [propertyFields, t]);
  const { snapshot } = session;
  const titleInput = useComposingValue(
    snapshot.draft,
    (value) => session.setDraft(value.replace(/[\r\n]+/g, ' ')),
  );

  const closePropertyPopups = useCallback(() => {
    setPropertyPickerOpen(false);
    setPropertyPickerAnchorRect(null);
    setIconPickerOpen(false);
    setIconPickerAnchorRect(null);
    setAddPropertyOpen(false);
    setAddPropertyAnchorRect(null);
    setAddPropertyTypeMenuOpen(false);
  }, []);

  const openPropertyPicker = useCallback((anchorRect: DOMRect) => {
    const keys: string[] = [];
    window.dispatchEvent(new CustomEvent('flowix:query-occupied-property-keys', {
      detail: { propertyTargetId, keys },
    }));
    setOccupiedPropertyKeys(new Set(keys));
    setPropertyPickerAnchorRect(anchorRect);
    setPropertyPickerOpen(true);
  }, [displayId]);

  const openAddPropertyForm = useCallback((anchorRect: DOMRect) => {
    setAddPropertyAnchorRect(anchorRect);
    setAddPropertyName('');
    setAddPropertyType('Text');
    setAddPropertyOptions([]);
    setAddPropertyTypeMenuOpen(false);
    setAddPropertyOpen(true);
  }, []);

  const closeIconPicker = useCallback((open: boolean) => {
    setIconPickerOpen(open);
    if (!open) setIconPickerAnchorRect(null);
  }, []);

  /** 属性横条与标题图标共用：写回 frontmatter flowix_icon（与编辑器共享保存队列）。 */
  const changeNoteIcon = useCallback((next: string) => {
    if (!filePath) return;
    setDocumentProperties(filePath, { flowix_icon: next }).then((saved) => {
      if (!saved) toast.error(t('media.properties.saveFailed'));
    }).catch((error) => {
      logger.error('设置笔记图标失败', { error });
      toast.error(t('media.properties.saveFailed'));
    });
  }, [filePath, t]);
  const noteIcon = useNotebookNoteIcon(filePath ?? null);

  useEffect(() => {
    const handleOpenPropertyPicker = (event: Event) => {
      const detail = (event as CustomEvent<{ propertyTargetId?: string; anchorRect?: DOMRect }>).detail;
      if (detail?.propertyTargetId !== propertyTargetId || !propertyActionsEnabled || !detail.anchorRect) return;
      openPropertyPicker(detail.anchorRect);
    };
    const handleOpenAddProperty = (event: Event) => {
      const detail = (event as CustomEvent<{ propertyTargetId?: string; anchorRect?: DOMRect }>).detail;
      if (detail?.propertyTargetId !== propertyTargetId || !propertyActionsEnabled || !detail.anchorRect) return;
      openAddPropertyForm(detail.anchorRect);
    };
    window.addEventListener('flowix:open-property-picker', handleOpenPropertyPicker);
    window.addEventListener('flowix:open-add-property', handleOpenAddProperty);
    return () => {
      window.removeEventListener('flowix:open-property-picker', handleOpenPropertyPicker);
      window.removeEventListener('flowix:open-add-property', handleOpenAddProperty);
    };
  }, [propertyTargetId, propertyActionsEnabled, openAddPropertyForm, openPropertyPicker]);

  const closePropertyPicker = useCallback((open: boolean) => {
    setPropertyPickerOpen(open);
    if (!open) setPropertyPickerAnchorRect(null);
  }, []);

  const closeAddPropertyForm = useCallback((open: boolean) => {
    // The type selector is the innermost layer. Its Escape closes first while
    // leaving the add-property form available.
    if (!open && addPropertyTypeMenuOpen) {
      setAddPropertyTypeMenuOpen(false);
      return;
    }
    setAddPropertyOpen(open);
    if (!open) {
      setAddPropertyAnchorRect(null);
      setAddPropertyTypeMenuOpen(false);
    }
  }, [addPropertyTypeMenuOpen]);

  const saveNewProperty = useCallback(async () => {
    const key = canonicalizePropertyKey(addPropertyName);
    if (!key) return;
    const normalizedKey = key.toLocaleLowerCase();
    try {
      if (!usePropertyPresetStore.getState().loaded) await usePropertyPresetStore.getState().load();
      if (occupiedPropertyKeys.has(key)
        || getPropertyPresets().some((field) => canonicalizePropertyKey(field.key).toLocaleLowerCase() === normalizedKey)
        || SYSTEM_FRONTMATTER_KEYS.has(normalizedKey)
        || ['flowix_property_types', 'flowix_plugin'].includes(normalizedKey)) {
        toast.error(t('document.properties.commonKey.alreadyExists'));
        return;
      }
      const options = addPropertyType === 'Select' || addPropertyType === 'MultiSelect'
        ? addPropertyOptions.reduce<TableFieldOption[]>((result, option) => {
          const label = option.label.trim();
          if (label && !result.some((item) => item.label === label)) result.push({ ...option, label });
          return result;
        }, [])
        : [];
      await savePropertyPreset({
        id: createPropertyId(),
        key,
        type: addPropertyType,
        ...(options.length ? { options: options.map((option) => ({ id: option.id, label: option.label })) } : {}),
        ...(addPropertyType === 'Image' ? { multiple: true } : {}),
      }, null);
      window.dispatchEvent(new CustomEvent('flowix:add-property', {
        detail: { propertyTargetId, presetKey: key },
      }));
      setOccupiedPropertyKeys((current) => new Set(current).add(key));
      closeAddPropertyForm(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('document.properties.add'));
    }
  }, [addPropertyName, addPropertyOptions, addPropertyType, closeAddPropertyForm, propertyTargetId, occupiedPropertyKeys, t]);

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
    // A freshly created note lands on its title. Place a collapsed caret at the
    // end instead of selecting the whole title, so the title text stays visible
    // and a stray keystroke cannot silently replace it.
    focusEnd();
  }, [autoFocus, displayId, editable, focusEnd]);

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
        <div
          className="memo-title-property-actions"
          data-popup-open={String(propertyPickerOpen || iconPickerOpen || addPropertyOpen)}
          data-property-area-hovered={String(propertyAreaHovered)}
        >
          {propertyActionsEnabled && (
            <>
              <Tooltip content={t('document.properties.picker.triggerLabel')} side="bottom">
                <button
                  type="button"
                  className="memo-title-property-action"
                  aria-label={t('document.properties.picker.triggerLabel')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    onActivateProperties?.();
                    window.dispatchEvent(new CustomEvent('flowix:open-property-picker', {
                      detail: { propertyTargetId, anchorRect: event.currentTarget.getBoundingClientRect() },
                    }));
                  }}
                >
                  <MousePointerClick className="h-4 w-4" aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip content={t('document.properties.add')} side="bottom">
                <button
                  type="button"
                  className="memo-title-property-action"
                  aria-label={t('document.properties.add')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    onActivateProperties?.();
                    window.dispatchEvent(new CustomEvent('flowix:open-add-property', {
                      detail: { propertyTargetId, anchorRect: event.currentTarget.getBoundingClientRect() },
                    }));
                  }}
                >
                  <PlusIcon size={16} weight="bold" aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip content={t('document.properties.icon.placeholder')} side="bottom">
                <button
                  type="button"
                  className="memo-title-property-action"
                  aria-label={t('document.properties.icon.placeholder')}
                  aria-haspopup="dialog"
                  aria-expanded={iconPickerOpen}
                  data-state={iconPickerOpen ? 'open' : 'closed'}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    onActivateProperties?.();
                    setIconPickerAnchorRect(event.currentTarget.getBoundingClientRect());
                    setIconPickerOpen(true);
                  }}
                >
                  {/* 与「图标」属性类型同款 svg (presets.ts BUILTIN_PRESETS)。 */}
                  <SmileyIcon className="h-4 w-4" aria-hidden="true" />
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip
            content={t(propertiesVisible ? 'document.properties.hide' : 'document.properties.show')}
            side="bottom"
          >
            <button
              type="button"
              className="memo-title-property-action memo-title-properties-toggle"
              aria-label={t(propertiesVisible ? 'document.properties.hide' : 'document.properties.show')}
              aria-pressed={propertiesVisible}
              data-state={propertiesVisible ? 'visible' : 'hidden'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleTogglePropertiesVisible}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M3 6H21V18H3V6ZM2 4C1.44772 4 1 4.44772 1 5V19C1 19.5523 1 20 2 20H22C2.55228 20 23 19.5523 23 19V5C23 4.44772 22.5523 4 22 4H2ZM13 9H19V11H13V9ZM18 13H13V15H18V13ZM6 13H7V16H9V11H6V13ZM9 8H7V10H9V8Z" />
              </svg>
            </button>
          </Tooltip>
        </div>
      )}
      <PropertyPresetMenu
        showTrigger={false}
        anchorRect={propertyPickerAnchorRect}
        side="right"
        align="start"
        customGroupLabel={t('preferences.documentProperties.group.mine')}
        customPresets={documentPropertyPresets.custom}
        systemPresets={documentPropertyPresets.system}
        disabled={!editable}
        open={propertyPickerOpen}
        onOpenChange={closePropertyPicker}
        t={t}
        onSelect={(preset) => {
          window.dispatchEvent(new CustomEvent('flowix:add-property', {
            detail: { propertyTargetId, presetKey: preset.key },
          }));
          setOccupiedPropertyKeys((current) => new Set(current).add(canonicalizePropertyKey(preset.key)));
          closePropertyPicker(false);
        }}
        onRemove={(preset) => {
          window.dispatchEvent(new CustomEvent('flowix:remove-property', {
            detail: { propertyTargetId, propertyKey: preset.key },
          }));
          setOccupiedPropertyKeys((current) => {
            const next = new Set(current);
            next.delete(canonicalizePropertyKey(preset.key));
            return next;
          });
          closePropertyPicker(false);
        }}
        isAdded={(preset) => occupiedPropertyKeys.has(canonicalizePropertyKey(preset.key))}
        onManage={() => {
          closePropertyPopups();
          void windows.openPreferences('noteSettings');
        }}
      />
      <Popover open={iconPickerOpen} onOpenChange={closeIconPicker} anchorRect={iconPickerAnchorRect}>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={0}
          className="z-[150] w-[280px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)] p-2"
        >
          <PropertyIconPickerPanel
            value={noteIcon ?? ''}
            disabled={!propertyActionsEnabled}
            onSelect={(next) => {
              changeNoteIcon(next);
              closeIconPicker(false);
            }}
            onClear={() => {
              changeNoteIcon('');
              closeIconPicker(false);
            }}
            clearLabel={t('document.properties.icon.clear')}
          />
        </PopoverContent>
      </Popover>
      <Popover open={addPropertyOpen} onOpenChange={closeAddPropertyForm} anchorRect={addPropertyAnchorRect}>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={0}
          ignorePopoverOutside={addPropertyTypeMenuOpen}
          style={{ zIndex: 170 }}
          className="memo-title-add-property max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
        >
          <TableFieldEditorForm
            name={addPropertyName}
            onNameChange={setAddPropertyName}
            namePlaceholder="填写属性名称"
            onNameSubmit={() => { void saveNewProperty(); }}
            type={addPropertyType}
            typeChoices={ADDABLE_TABLE_PROPERTY_KINDS.filter((type): type is EditorAddablePropertyType => type !== 'Note')}
            onTypeChange={(type) => {
              if (type === 'primary') return;
              setAddPropertyType(type);
              setAddPropertyOptions((current) => type === 'Select' || type === 'MultiSelect'
                ? current.length > 0 ? current : [{ id: createPropertyOptionId(), label: '' }]
                : []);
            }}
            typeMenuOpen={addPropertyTypeMenuOpen}
            onTypeMenuOpenChange={setAddPropertyTypeMenuOpen}
            options={addPropertyOptions}
            onOptionsChange={setAddPropertyOptions}
            customPresets={documentPropertyPresets.custom}
            systemPresets={documentPropertyPresets.system}
            presetMenuOpen={false}
            onPresetMenuOpenChange={() => {}}
            showPresetMenu={false}
            disabled={!editable}
            t={t}
            typeLabel={(type) => t(getPropertyTypeDefinition(type === 'primary' ? 'Note' : type).labelKey)}
            typeIconKind={(type) => type === 'primary' ? 'note' : getPropertyTypeDefinition(type).iconKind}
            onSelectPreset={() => {}}
            onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
            afterFooter={<button
              type="button"
              disabled={!editable || !addPropertyName.trim()}
              onClick={() => { void saveNewProperty(); }}
              className="mt-1 flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
            >{t('document.properties.addFieldPanel.save')}</button>}
          />
        </PopoverContent>
      </Popover>
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
