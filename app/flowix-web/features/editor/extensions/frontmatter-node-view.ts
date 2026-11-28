import { renderFrontmatterPropertyValue } from './frontmatter-property-value';
import { FrontmatterPropertyEditor, type ActivePropertyEdit, getPropertyEditKind, getPropertyEditValue, resolveRuntimePropertyPreset } from './frontmatter-property-editor';
import { PROPERTY_TYPES_KEY } from '@features/document/properties/property-type-metadata';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { createElement as createReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { translate } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { NotePropertyImageValue } from '@features/document/properties/image-value-input';
import {
  deleteVisibleFrontmatterProperty,
  FrontmatterPropertyError,
  isFrontmatterPropertyFlowSequence,
  moveVisibleFrontmatterProperty,
  parseVisibleFrontmatter,
  reorderVisibleFrontmatterProperty,
  suggestFrontmatterRepair,
  updateVisibleFrontmatterProperty,
} from '@features/document/properties/frontmatter-model';
import { resolvePropertyDisplayName } from '@features/document/properties/presets';
import {
  resolvePropertyType,
  type PropertyDisplayKind,
} from '@features/document/properties/property-type';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { getPropertyPresets } from '@features/properties/public-api';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { createPropertySvgIcon } from '@features/document/properties/property-type-icon';
import { observeFrontmatterView } from './frontmatter-view-lifecycle';
import { syncFrontmatterEditability } from './frontmatter-interactions';
import { describeFrontmatterPropertyError } from './frontmatter-property-error';
import { createPropertyItemMenu } from './frontmatter-property-menu';
import { syncFrontmatterVisibility } from './frontmatter-visibility';
import { useSettingsStore } from '@/lib/store/settings-store';

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const EDITOR_EDITABILITY_CHANGE_EVENT = 'flowix:editor-editability-change';

function getPropertyDisplayKind(
  key: string,
  value: unknown,
  isFlowSequence = false,
  declaredTypes: unknown = {},
): PropertyDisplayKind {
  return resolvePropertyType(
    key,
    value,
    isFlowSequence,
    getPropertyPresets(),
    declaredTypes,
  ).displayKind;
}

type PropertyPointerDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  list: HTMLElement;
  sourceRow: HTMLElement;
  sourceIcon: HTMLElement;
  sourcePropertyKey: string;
  sourceNextSibling: ChildNode | null;
  sourceDetached: boolean;
  active: boolean;
  targetRow: HTMLElement | null;
  placement: 'before' | 'after' | null;
  placeholder: HTMLElement | null;
};

export class FrontmatterPropertyNodeView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProseMirrorNode;
  private readonly propertyTargetId?: string;
  private validationError: string | null = null;
  private propertyRows = new Map<string, { signature: string; dom: HTMLElement }>();
  private propertyImageRoots = new Map<HTMLElement, { root: Root; render: () => void }>();
  private destroyed = false;
  private readonly propertyEditor: FrontmatterPropertyEditor;
  private get activePropertyEdit() { return this.propertyEditor.activePropertyEdit; }
  private activePropertyMenu: HTMLElement | null = null;
  private activePropertyMenuAnchor: HTMLElement | null = null;
  private suppressNextPropertyIconClick = false;
  private suppressPropertyIconClickTimer: number | null = null;
  private propertyDragPreview: HTMLElement | null = null;
  private propertyPointerDrag: PropertyPointerDrag | null = null;
  private readonly disposeSubscriptions: () => void;
  private readonly handleDocumentPointerDown = (event: Event) => {
    const target = event.target;
    const targetElement = target instanceof Element ? target : null;
    if (
      this.activePropertyMenu
      && target instanceof globalThis.Node
      && !this.activePropertyMenu.contains(target)
    ) {
      this.closePropertyMenu();
    }
    if (
      this.activePropertyEdit
      && target instanceof globalThis.Node
      && !this.activePropertyEdit.popover.contains(target)
      && !targetElement?.closest('.frontmatter-property__date-picker-popover')
    ) {
      this.savePropertyEdit();
    }
  };
  private readonly handleDocumentSelectStart = (event: Event) => {
    if (!this.propertyPointerDrag?.active) return;
    event.preventDefault();
  };
  private readonly handleFlushDrafts = () => {
    this.savePropertyEdit();
  };
  private propertyAreaHovered = false;
  private readonly handlePropertyAreaPointerEnter = () => this.setPropertyAreaHovered(true);
  private readonly handlePropertyAreaPointerLeave = () => this.setPropertyAreaHovered(false);
  private readonly handleEditabilityChange = () => {
    if (!this.view.editable) {
      this.closePropertyMenu();
      this.savePropertyEdit();
      this.finishPropertyDrag(true);
    }
    this.syncPropertyEditability();
  };
  private readonly handleAddPropertyRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ propertyTargetId?: string; presetKey?: string }>).detail;
    if (detail?.propertyTargetId !== this.propertyTargetId || !this.view.editable) return;
    this.addPresetProperty(detail?.presetKey);
  };
  private readonly handleRemovePropertyRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ propertyTargetId?: string; propertyKey?: string }>).detail;
    if (detail?.propertyTargetId !== this.propertyTargetId || !detail.propertyKey || !this.view.editable) return;
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const property = parsed.properties.find(({ key }) =>
      canonicalizePropertyKey(key) === canonicalizePropertyKey(detail.propertyKey!),
    );
    if (property) this.updatePropertyStructure(property.key, 'delete');
  };

  /**
   * Answer a synchronous "which keys are already occupied?" query so callers
   * outside the editor (e.g. the title menu) can disable presets that would be
   * rejected as duplicates. The requester owns the mutable array passed in
   * `detail.keys`; we only push canonical keys into it.
   */
  private readonly handleOccupiedKeysRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ propertyTargetId?: string; keys?: string[] }>).detail;
    if (detail?.propertyTargetId !== this.propertyTargetId || !detail.keys) return;
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    detail.keys.push(...parsed.properties.map(({ key }) => canonicalizePropertyKey(key)));
  };

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    propertyTargetId?: string,
    private readonly onViewSourceMode?: () => void,
    private readonly getAttachmentNotebookId?: () => string | undefined,
    private readonly onPropertyAreaHoverChange?: (hovered: boolean) => void,
  ) {
    this.node = node;
    this.propertyTargetId = propertyTargetId;
    this.dom = createElement('div', 'frontmatter-property-node');
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('pointerenter', this.handlePropertyAreaPointerEnter);
    this.dom.addEventListener('pointerleave', this.handlePropertyAreaPointerLeave);
    this.propertyEditor = new FrontmatterPropertyEditor({
      ownerDocument: this.dom.ownerDocument,
      isEditable: () => this.view.editable,
      getYaml: () => String(this.node.attrs.yamlContent ?? ''),
      getDeclaredTypes: () => this.getDeclaredPropertyTypes(),
      onSave: (edit) => this.applyPropertyEdit(edit),
    });
    this.view.dom.addEventListener('flowix:editor-flush-drafts', this.handleFlushDrafts);
    this.view.dom.addEventListener(EDITOR_EDITABILITY_CHANGE_EVENT, this.handleEditabilityChange);
    this.disposeSubscriptions = observeFrontmatterView(this.dom.ownerDocument, {
      render: () => this.render(),
      pointerDown: this.handleDocumentPointerDown,
      selectStart: this.handleDocumentSelectStart,
      addProperty: this.handleAddPropertyRequest,
      removeProperty: this.handleRemovePropertyRequest,
      occupiedKeys: this.handleOccupiedKeysRequest,
      pointerMove: this.handlePropertyPointerMove,
      pointerUp: this.handlePropertyPointerUp,
      pointerCancel: this.handlePropertyPointerCancel,
      blur: this.handlePropertyWindowBlur,
    });
    this.render();
  }

  private t(key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) {
    return translate(getCurrentAppLanguage(), key, params);
  }

  private errorMessage(error: unknown): string {
    return describeFrontmatterPropertyError(error, this.t.bind(this));
  }

  private setPropertyAreaHovered(hovered: boolean) {
    if (this.propertyAreaHovered === hovered) return;
    this.propertyAreaHovered = hovered;
    this.onPropertyAreaHoverChange?.(hovered);
  }

  private closePropertyEditor() {
    this.propertyEditor.closePropertyEditor();
  }

  private closePropertyMenu() {
    this.activePropertyMenu?.remove();
    this.activePropertyMenuAnchor?.setAttribute('aria-expanded', 'false');
    this.activePropertyMenu = null;
    this.activePropertyMenuAnchor = null;
  }

  private armPropertyIconClickSuppression() {
    this.suppressNextPropertyIconClick = true;
    const ownerWindow = this.dom.ownerDocument.defaultView;
    if (this.suppressPropertyIconClickTimer !== null) {
      ownerWindow?.clearTimeout(this.suppressPropertyIconClickTimer);
    }
    this.suppressPropertyIconClickTimer = ownerWindow?.setTimeout(() => {
      this.suppressNextPropertyIconClick = false;
      this.suppressPropertyIconClickTimer = null;
    }, 0) ?? null;
  }

  private consumeSuppressedPropertyIconClick() {
    if (!this.suppressNextPropertyIconClick) return false;
    this.suppressNextPropertyIconClick = false;
    const ownerWindow = this.dom.ownerDocument.defaultView;
    if (this.suppressPropertyIconClickTimer !== null) {
      ownerWindow?.clearTimeout(this.suppressPropertyIconClickTimer);
      this.suppressPropertyIconClickTimer = null;
    }
    return true;
  }

  private setPropertyDragSelectionLock(locked: boolean) {
    const documentElement = this.dom.ownerDocument.documentElement;
    documentElement.classList.toggle('frontmatter-property--dragging', locked);
    if (!locked) return;
    const selection = this.dom.ownerDocument.getSelection();
    // A collapsed range in the editor is the native IME insertion point.
    // Preserve editor selections; the drag lock already prevents new text
    // selection, while unrelated highlighted page text can still be cleared.
    if (selection && !selection.isCollapsed
      && !(selection.anchorNode && this.view.dom.contains(selection.anchorNode))
      && !(selection.focusNode && this.view.dom.contains(selection.focusNode))) {
      selection.removeAllRanges();
    }
  }

  private syncPropertyEditability() {
    syncFrontmatterEditability(this.dom, this.view.editable);
    this.propertyImageRoots.forEach(({ render }) => render());
  }

  private disposePropertyImageRoots(all = false) {
    this.propertyImageRoots.forEach(({ root }, container) => {
      if (!all && this.dom.contains(container)) return;
      root.unmount();
      this.propertyImageRoots.delete(container);
    });
  }

  private updatePropertyStructure(
    propertyKey: string,
    action: 'up' | 'down' | 'delete',
  ) {
    const yamlContent = String(this.node.attrs.yamlContent ?? '');
    try {
      const nextYamlContent = action === 'delete'
        ? deleteVisibleFrontmatterProperty(yamlContent, propertyKey)
        : moveVisibleFrontmatterProperty(yamlContent, propertyKey, action);
      const pos = this.getPos();
      if (typeof pos !== 'number') return;
      this.closePropertyMenu();
      this.validationError = null;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          yamlContent: nextYamlContent,
        }),
      );
    } catch (error) {
      this.closePropertyMenu();
      this.validationError = this.errorMessage(error);
      this.render();
    }
  }

  private createPropertyDragPreview(row: HTMLElement, clientX: number, clientY: number) {
    if (this.propertyDragPreview) return;
    const preview = createElement('div', 'frontmatter-property__drag-preview');
    const sourceIcon = row.querySelector<HTMLElement>('.frontmatter-property__type-icon');
    const icon = sourceIcon?.cloneNode(true) as HTMLElement | null;
    const key = createElement(
      'span',
      'frontmatter-property__drag-preview-key',
      row.querySelector('.frontmatter-property__key')?.textContent ?? row.dataset.propertyKey ?? '',
    );
    const value = createElement(
      'span',
      'frontmatter-property__drag-preview-value',
      row.querySelector('.frontmatter-property__display-value')?.textContent ?? '',
    );
    if (icon) {
      icon.removeAttribute('aria-expanded');
      icon.removeAttribute('aria-haspopup');
      icon.removeAttribute('aria-grabbed');
      icon.removeAttribute('tabindex');
      preview.append(icon);
    }
    preview.append(key, value);
    preview.style.left = '0';
    preview.style.top = '0';
    preview.style.transform = `translate3d(${clientX + 12}px, ${clientY + 12}px, 0)`;
    this.dom.ownerDocument.body.append(preview);
    this.propertyDragPreview = preview;
  }

  private updatePropertyDragPreview(clientX: number, clientY: number) {
    if (!this.propertyDragPreview) return;
    this.propertyDragPreview.style.transform = `translate3d(${clientX + 12}px, ${clientY + 12}px, 0)`;
  }

  private createPropertyPlaceholder(sourceRow: HTMLElement) {
    const placeholder = sourceRow.cloneNode(true) as HTMLElement;
    placeholder.classList.remove('frontmatter-property__display--dragging');
    placeholder.classList.add('frontmatter-property__display--drag-placeholder');
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.removeAttribute('tabindex');
    placeholder.querySelectorAll<HTMLElement>('[tabindex]').forEach((element) => {
      element.removeAttribute('tabindex');
    });
    placeholder.querySelectorAll<HTMLElement>('[aria-expanded], [aria-haspopup], [aria-grabbed]')
      .forEach((element) => {
        element.removeAttribute('aria-expanded');
        element.removeAttribute('aria-haspopup');
        element.removeAttribute('aria-grabbed');
      });
    return placeholder;
  }

  private animatePropertyRows(
    list: HTMLElement,
    mutate: () => void,
  ) {
    const rows = [...list.querySelectorAll<HTMLElement>(
      '.frontmatter-property__display:not(.frontmatter-property__display--drag-placeholder)',
    )];
    const firstTops = new Map(rows.map((row) => [row, row.getBoundingClientRect().top]));

    // If a previous transition is still running, measure its current visual
    // position, then use that position as the next FLIP starting point.
    rows.forEach((row) => {
      row.style.transition = 'none';
      row.style.transform = 'none';
    });
    mutate();

    rows.forEach((row) => {
      const firstTop = firstTops.get(row);
      if (firstTop === undefined || !row.isConnected) return;
      const deltaY = firstTop - row.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 0.5) {
        row.style.transition = '';
        row.style.transform = '';
        return;
      }

      row.style.transform = `translate3d(0, ${deltaY}px, 0)`;
      void row.offsetHeight;
      row.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      row.style.transform = 'translate3d(0, 0, 0)';

      const clearAnimation = () => {
        row.style.transition = '';
        row.style.transform = '';
      };
      row.addEventListener('transitionend', clearAnimation, { once: true });
      this.dom.ownerDocument.defaultView?.setTimeout(clearAnimation, 220);
    });
  }

  private updatePropertyDropTarget(
    drag: PropertyPointerDrag,
    targetRow: HTMLElement | null,
    placement: 'before' | 'after' | null,
  ) {
    if (drag.targetRow === targetRow && drag.placement === placement) return;

    const list = drag.list;

    drag.targetRow = targetRow;
    drag.placement = placement;
    this.animatePropertyRows(list, () => {
      drag.placeholder?.remove();
      if (!targetRow || !placement || !drag.placeholder) {
        if (drag.sourceDetached) {
          const sourceAnchor = drag.sourceNextSibling?.parentNode === list
            ? drag.sourceNextSibling
            : null;
          list.insertBefore(drag.sourceRow, sourceAnchor);
          drag.sourceDetached = false;
        }
        return;
      }

      const insertionPoint = placement === 'before' ? targetRow : targetRow.nextSibling;
      list.insertBefore(drag.placeholder, insertionPoint);
      // Keep the original slot occupied until the new placeholder is already
      // in the list. This makes the list height stable during the swap.
      if (!drag.sourceDetached) {
        drag.sourceRow.remove();
        drag.sourceDetached = true;
      }
    });
  }

  private getPropertyLayoutBounds(row: HTMLElement) {
    const visualBounds = row.getBoundingClientRect();
    const offsetParent = row.offsetParent;
    const offsetParentBounds = offsetParent?.getBoundingClientRect();
    const top = offsetParentBounds
      ? offsetParentBounds.top + row.offsetTop
      : visualBounds.top;
    const height = row.offsetHeight || visualBounds.height;
    return { top, bottom: top + height, height };
  }

  private resolvePropertyDropTarget(
    drag: PropertyPointerDrag,
    clientY: number,
  ) {
    const list = drag.list;
    const placeholder = drag.placeholder;
    if (placeholder?.parentElement === list) {
      const bounds = this.getPropertyLayoutBounds(placeholder);
      const tolerance = Math.min(8, Math.max(4, bounds.height * 0.2));
      if (clientY >= bounds.top - tolerance && clientY <= bounds.bottom + tolerance) {
        return { targetRow: drag.targetRow, placement: drag.placement };
      }
    }

    if (!drag.sourceDetached) {
      const sourceBounds = this.getPropertyLayoutBounds(drag.sourceRow);
      if (clientY >= sourceBounds.top && clientY <= sourceBounds.bottom) {
        return { targetRow: null, placement: null };
      }
    }

    const rows = [...list.querySelectorAll<HTMLElement>(
      '.frontmatter-property__display:not(.frontmatter-property__display--drag-placeholder)',
    )].filter((row) => row !== drag.sourceRow);
    let lastRow: HTMLElement | null = null;
    let lastPlacement: 'before' | 'after' | null = null;
    for (const row of rows) {
      const bounds = this.getPropertyLayoutBounds(row);
      const midpoint = bounds.top + bounds.height / 2;
      if (clientY < midpoint) {
        const placement: 'before' | 'after' = drag.targetRow === row && drag.placement === 'after'
          && clientY >= midpoint - Math.min(8, Math.max(4, bounds.height * 0.12))
          ? 'after'
          : 'before';
        return { targetRow: row, placement };
      }
      lastRow = row;
      lastPlacement = drag.targetRow === row && drag.placement === 'before'
        && clientY <= midpoint + Math.min(8, Math.max(4, bounds.height * 0.12))
        ? 'before'
        : 'after';
    }

    return { targetRow: lastRow, placement: lastPlacement };
  }

  private finishPropertyDrag(animate = false, restoreSource = true) {
    const drag = this.propertyPointerDrag;
    if (drag) {
      const restoreSourcePlaceholder = () => {
        drag.placeholder?.remove();
        if (!drag.sourceDetached) return;
        const sourceAnchor = drag.sourceNextSibling?.parentNode === drag.list
          ? drag.sourceNextSibling
          : null;
        drag.list.insertBefore(drag.sourceRow, sourceAnchor);
        drag.sourceDetached = false;
      };
      if (restoreSource) {
        if (animate && drag.placeholder?.parentElement === drag.list) {
          this.animatePropertyRows(drag.list, restoreSourcePlaceholder);
        } else if (drag.sourceDetached) {
          restoreSourcePlaceholder();
        } else {
          drag.placeholder?.remove();
        }
      } else {
        drag.placeholder?.remove();
      }
    }
    drag?.sourceRow.classList.remove('frontmatter-property__display--dragging');
    drag?.sourceIcon.setAttribute('aria-grabbed', 'false');
    this.setPropertyDragSelectionLock(false);
    this.propertyDragPreview?.remove();
    this.propertyDragPreview = null;
    this.propertyPointerDrag = null;
  }

  private reorderProperty(
    propertyKey: string,
    targetPropertyKey: string,
    placement: 'before' | 'after',
  ) {
    const yamlContent = String(this.node.attrs.yamlContent ?? '');
    const nextYamlContent = reorderVisibleFrontmatterProperty(
      yamlContent,
      propertyKey,
      targetPropertyKey,
      placement,
    );
    if (nextYamlContent === yamlContent) {
      this.finishPropertyDrag(true, true);
      return;
    }

    const pos = this.getPos();
    if (typeof pos !== 'number') {
      this.finishPropertyDrag(true, true);
      return;
    }
    this.finishPropertyDrag(false, false);
    this.validationError = null;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        yamlContent: nextYamlContent,
      }),
    );
  }

  private beginPropertyPointerDrag(
    row: HTMLElement,
    dragSource: HTMLElement,
    propertyKey: string,
    event: PointerEvent,
  ) {
    if (!this.view.editable || event.button !== 0) return;
    if (this.propertyPointerDrag) this.finishPropertyDrag();
    const list = row.parentElement;
    if (!list) return;
    this.propertyPointerDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      list,
      sourceRow: row,
      sourceIcon: dragSource,
      sourcePropertyKey: propertyKey,
      sourceNextSibling: row.nextSibling,
      sourceDetached: false,
      active: false,
      targetRow: null,
      placement: null,
      placeholder: null,
    };
  }

  private readonly handlePropertyPointerMove = (event: PointerEvent) => {
    const drag = this.propertyPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    if (!drag.active) {
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (distance < 5) return;
      drag.active = true;
      this.closePropertyMenu();
      this.closePropertyEditor();
      this.setPropertyDragSelectionLock(true);
      this.createPropertyDragPreview(drag.sourceRow, event.clientX, event.clientY);
      drag.placeholder = this.createPropertyPlaceholder(drag.sourceRow);
      drag.sourceRow.classList.add('frontmatter-property__display--dragging');
      drag.sourceIcon.setAttribute('aria-grabbed', 'true');
    }

    event.preventDefault();
    this.updatePropertyDragPreview(event.clientX, event.clientY);

    const { targetRow, placement } = this.resolvePropertyDropTarget(drag, event.clientY);
    this.updatePropertyDropTarget(drag, targetRow, placement);
  };

  private readonly handlePropertyPointerUp = (event: PointerEvent) => {
    const drag = this.propertyPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      this.propertyPointerDrag = null;
      return;
    }

    event.preventDefault();
    this.armPropertyIconClickSuppression();
    const targetPropertyKey = drag.targetRow?.dataset.propertyKey;
    const placement = drag.placement;
    const sourcePropertyKey = drag.sourcePropertyKey;
    if (targetPropertyKey && placement) {
      this.reorderProperty(sourcePropertyKey, targetPropertyKey, placement);
    } else {
      this.finishPropertyDrag(true, true);
    }
  };

  private readonly handlePropertyPointerCancel = (event: PointerEvent) => {
    const drag = this.propertyPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.finishPropertyDrag(true);
  };

  private readonly handlePropertyWindowBlur = () => {
    if (this.propertyPointerDrag) this.finishPropertyDrag(true);
  };

  private bindPropertyDrag(
    row: HTMLElement,
    dragSource: HTMLElement,
    propertyKey: string,
  ) {
    // Sorting is intentionally pointer-driven. Keeping the icon non-draggable
    // avoids the browser's native drag image and its competing drag lifecycle.
    dragSource.draggable = false;
    dragSource.setAttribute('aria-grabbed', 'false');
    dragSource.addEventListener('pointerdown', (event) => {
      this.beginPropertyPointerDrag(row, dragSource, propertyKey, event);
    });
  }

  private openPropertyMenu(
    property: { key: string; value: unknown },
    anchor: HTMLElement,
  ) {
    if (!this.view.editable) return;
    this.closePropertyMenu();
    const ownerDocument = this.dom.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return;

    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const propertyIndex = parsed.properties.findIndex((item) => item.key === property.key);
    const menu = createPropertyItemMenu(anchor, property.key, propertyIndex, parsed.properties.length,
      (action) => this.updatePropertyStructure(property.key, action));
    anchor.setAttribute('aria-expanded', 'true');
    this.activePropertyMenu = menu;
    this.activePropertyMenuAnchor = anchor;
    menu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.closePropertyMenu();
      anchor.focus();
    });
  }

  private savePropertyEdit() {
    this.propertyEditor.savePropertyEdit();
  }

  private applyPropertyEdit(activeEdit: ActivePropertyEdit) {
    const nextInputValue = activeEdit.control.getValue();
    const nextKeyInput = activeEdit.target === 'key'
      ? nextInputValue
      : activeEdit.property.key;
    const nextValueInput = activeEdit.target === 'value'
      && typeof activeEdit.property.value === 'boolean'
      ? nextInputValue.trim()
      : activeEdit.target === 'value'
        ? nextInputValue
        : getPropertyEditValue(activeEdit.property.value, activeEdit.property.key);
    const selectedKeyPreset = activeEdit.target === 'key'
      ? resolveRuntimePropertyPreset(nextKeyInput)
      : null;
    const kind = activeEdit.target === 'value' ? activeEdit.kind : selectedKeyPreset?.kind;
    const storageKind = activeEdit.target === 'value'
      ? activeEdit.control.storageKind
      : selectedKeyPreset?.kind;

    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        String(this.node.attrs.yamlContent ?? ''),
        activeEdit.property.key,
        nextKeyInput,
        nextValueInput,
        storageKind,
        kind,
      );
      if (nextYamlContent === String(this.node.attrs.yamlContent ?? '')) return;
      const pos = this.getPos();
      if (typeof pos !== 'number') return;
      this.validationError = null;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          yamlContent: nextYamlContent,
        }),
      );
    } catch (error) {
      this.validationError = this.errorMessage(error);
      if (activeEdit.target === 'key'
        && error instanceof FrontmatterPropertyError
        && error.code === 'duplicate-key') {
        toast.error(this.t('document.properties.duplicateKey'));
      }
      this.render();
    }
  }

  private updateBooleanProperty(
    property: { key: string; value: unknown },
    nextValue: boolean,
  ) {
    if (!this.view.editable) return;
    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        String(this.node.attrs.yamlContent ?? ''),
        property.key,
        property.key,
        String(nextValue),
        'Boolean',
      );
      const pos = this.getPos();
      if (typeof pos !== 'number') return;
      this.validationError = null;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          yamlContent: nextYamlContent,
        }),
      );
    } catch (error) {
      this.validationError = this.errorMessage(error);
      this.render();
    }
  }

  private openPropertyEditor(property: { key: string; value: unknown }, anchor: HTMLElement, target: 'key' | 'value') {
    this.propertyEditor.open(property, anchor, target);
  }

  private propertyTypesSource: string | null = null;
  private declaredPropertyTypes: unknown = {};

  private getDeclaredPropertyTypes(): unknown {
    const source = String(this.node.attrs.yamlContent ?? '');
    if (source !== this.propertyTypesSource) {
      this.propertyTypesSource = source;
      this.declaredPropertyTypes = parseVisibleFrontmatter(source).data[PROPERTY_TYPES_KEY];
    }
    return this.declaredPropertyTypes;
  }

  private renderPropertyValue(
    property: { key: string; value: unknown },
    isFlowSequence = false,
  ): HTMLElement {
    const valueContainer = createElement('div', 'frontmatter-property__display-value');
    const kind = getPropertyDisplayKind(property.key, property.value, isFlowSequence, this.getDeclaredPropertyTypes());
    const propertyKind = getPropertyEditKind(property.key, property.value, isFlowSequence, this.getDeclaredPropertyTypes());

    if (propertyKind === 'Image') {
      valueContainer.dataset.propertyType = 'Image';
      const root = createRoot(valueContainer);
      const render = () => {
        const notebookId = this.getAttachmentNotebookId?.();
        const notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId);
        root.render(createReactElement(NotePropertyImageValue, {
          value: property.value,
          notebook,
          disabled: !this.view.editable,
          onChange: (paths: string[]) => {
            if (this.destroyed || !this.view.editable) return;
            const yaml = String(this.node.attrs.yamlContent ?? '');
            const current = parseVisibleFrontmatter(yaml).properties.find((item) => item.key === property.key);
            if (!current || getPropertyEditKind(current.key, current.value, false, this.getDeclaredPropertyTypes()) !== 'Image') return;
            const pos = this.getPos();
            if (typeof pos !== 'number') return;
            try {
              const yamlContent = updateVisibleFrontmatterProperty(yaml, current.key, current.key, paths, 'Image');
              this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, {
                ...this.node.attrs,
                yamlContent,
              }));
            } catch (error) {
              toast.error(this.errorMessage(error));
            }
          },
        }));
      };
      this.propertyImageRoots.set(valueContainer, { root, render });
      return valueContainer;
    }

    return renderFrontmatterPropertyValue(property, kind, propertyKind, {
      isEditable: () => this.view.editable,
      onBooleanChange: (value) => this.updateBooleanProperty(property, value),
      t: this.t.bind(this),
    });
  }

  private bindPropertyEdit(
    cell: HTMLElement,
    property: { key: string; value: unknown },
    target: 'key' | 'value',
  ) {
    cell.addEventListener('click', (event) => {
      if (!this.view.editable) return;
      const eventTarget = event.target;
      if (
        eventTarget instanceof Element
        && eventTarget.closest('button, input, textarea, select')
      ) {
        return;
      }
      if (eventTarget instanceof HTMLAnchorElement) event.preventDefault();
      this.openPropertyEditor(property, cell, target);
    });
    cell.addEventListener('keydown', (event) => {
      if (!this.view.editable) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.openPropertyEditor(property, cell, target);
    });
  }

  private renderPropertyRow(
    property: { key: string; value: unknown },
    isFlowSequence = false,
  ): HTMLElement {
    const kind = getPropertyDisplayKind(property.key, property.value, isFlowSequence, this.getDeclaredPropertyTypes());
    const row = createElement('div', 'frontmatter-property__display');
    row.dataset.propertyKey = property.key;

    const icon = createElement(
      'span',
      `frontmatter-property__type-icon frontmatter-property__type-icon--${kind}`,
    );
    icon.addEventListener('click', () => {
      if (!this.view.editable || this.consumeSuppressedPropertyIconClick()) return;
      this.openPropertyMenu(property, icon);
    });
    icon.addEventListener('keydown', (event) => {
      if (!this.view.editable || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      this.openPropertyMenu(property, icon);
    });
    icon.append(createPropertySvgIcon(kind));

    const key = createElement('span', 'frontmatter-property__display-key');
    key.title = property.key;
    const propertyLabel = resolvePropertyDisplayName(
      property.key,
      getPropertyPresets(),
      (labelKey) => this.t(labelKey),
    );
    key.append(createElement(
      'span',
      'frontmatter-property__key',
      propertyLabel,
    ));
    const value = this.renderPropertyValue(property, isFlowSequence);

    this.bindPropertyEdit(key, property, 'key');
    if (value.dataset.propertyType !== 'Image') this.bindPropertyEdit(value, property, 'value');
    this.bindPropertyDrag(row, icon, property.key);

    row.append(icon, key, value);
    return row;
  }

  /** Add a selected preset as a saved property. */
  private addPresetProperty(presetKey?: string) {
    if (!presetKey) return;
    const yamlContent = String(this.node.attrs.yamlContent ?? '');
    const parsed = parseVisibleFrontmatter(yamlContent);
    const existingKeys = new Set(Object.keys(parsed.data));

    const preset = resolveRuntimePropertyPreset(presetKey);
    if (!preset) return;
    const canonicalKey = canonicalizePropertyKey(preset.key);
    if ([...existingKeys].some((key) => canonicalizePropertyKey(key) === canonicalKey)) {
      toast.error(this.t('document.properties.duplicateKey'));
      return;
    }

    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        yamlContent,
        null,
        preset.key,
        '',
        preset.kind,
      );
      const pos = this.getPos();
      if (typeof pos !== 'number') return;
      this.validationError = null;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          yamlContent: nextYamlContent,
        }),
      );
    } catch (error) {
      this.validationError = this.errorMessage(error);
      if (error instanceof FrontmatterPropertyError && error.code === 'duplicate-key') {
        toast.error(this.t('document.properties.duplicateKey'));
      }
      this.render();
    }
  }

  private repairMalformedFrontmatter() {
    const repair = suggestFrontmatterRepair(String(this.node.attrs.yamlContent ?? ''));
    if (!repair) return;

    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const currentNode = this.view.state.doc.nodeAt(pos);
    if (!currentNode || currentNode.type.name !== 'frontmatter') return;

    const { schema } = this.view.state;
    const bodyType = schema.nodes.codeBlock ?? schema.nodes.paragraph;
    const bodyNode = bodyType.create(null, schema.text(repair.bodyContent));
    const transaction = this.view.state.tr
      .setNodeMarkup(pos, undefined, {
        ...currentNode.attrs,
        yamlContent: repair.yamlContent,
      })
      .insert(pos + currentNode.nodeSize, bodyNode);

    this.validationError = null;
    this.view.dispatch(transaction);
  }

  private render(preserveRows = false) {
    if (!preserveRows) this.propertyRows.clear();
    this.closePropertyMenu();
    this.closePropertyEditor();
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const propertiesVisible = useSettingsStore.getState().propertiesVisible;
    syncFrontmatterVisibility(this.dom, propertiesVisible);
    if (!propertiesVisible) {
      this.setPropertyAreaHovered(false);
      return;
    }
    if (!parsed.parseError && parsed.properties.length === 0) {
      this.setPropertyAreaHovered(false);
      this.propertyRows.clear();
      this.dom.replaceChildren();
      this.disposePropertyImageRoots();
      return;
    }

    const existingList = !parsed.parseError && preserveRows
      ? this.dom.querySelector<HTMLElement>('.frontmatter-property__list')
      : null;
    const container = existingList?.parentElement ?? createElement('div', 'frontmatter-property');

    if (parsed.parseError) {
      container.classList.add('frontmatter-property--error');
      const error = createElement(
        'div',
        'frontmatter-property__error',
        this.t('document.properties.yamlParseError'),
      );
      error.title = parsed.parseError;
      container.append(error);
      if (suggestFrontmatterRepair(String(this.node.attrs.yamlContent ?? ''))) {
        const repair = createElement(
          'button',
          'frontmatter-property__repair',
          this.t('document.properties.repair'),
        );
        repair.type = 'button';
        repair.addEventListener('click', () => this.repairMalformedFrontmatter());
        container.append(repair);

        const source = createElement(
          'button',
          'frontmatter-property__source',
          this.t('document.action.viewSource'),
        );
        source.type = 'button';
        source.addEventListener('click', () => {
          if (this.onViewSourceMode) this.onViewSourceMode();
          else window.dispatchEvent(new CustomEvent('flowix:view-source-mode'));
        });
        container.append(source);
      }
    } else {
      if (parsed.properties.length > 0) {
        const list = existingList ?? createElement('div', 'frontmatter-property__list');
        let cursor = list.firstChild;
        const nextRows = new Map<string, { signature: string; dom: HTMLElement }>();
        parsed.properties.forEach((property) => {
          const flowSequence = isFrontmatterPropertyFlowSequence(String(this.node.attrs.yamlContent ?? ''), property.key);
          const types = parsed.data[PROPERTY_TYPES_KEY] as Record<string, unknown> | undefined;
          const signature = JSON.stringify([property.value, flowSequence, types?.[property.key]]);
          const previous = this.propertyRows.get(property.key);
          const row = previous?.signature === signature
            ? previous
            : { signature, dom: this.renderPropertyRow(property, flowSequence) };
          nextRows.set(property.key, row);
          if (row.dom !== cursor) list.insertBefore(row.dom, cursor);
          cursor = row.dom.nextSibling;
        });
        this.propertyRows = nextRows;
        while (cursor) {
          const next = cursor.nextSibling;
          cursor.remove();
          cursor = next;
        }
        if (this.validationError) {
          const validation = createElement(
            'span',
            'frontmatter-property__validation',
            this.validationError,
          );
          validation.title = this.validationError;
          list.append(validation);
        }
        if (list.parentElement !== container) container.append(list);
      } else {
        this.propertyRows.clear();
      }
    }

    if (container.parentElement !== this.dom) this.dom.replaceChildren(container);
    this.disposePropertyImageRoots();
    this.syncPropertyEditability();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const yamlChanged = node.attrs.yamlContent !== this.node.attrs.yamlContent;
    this.node = node;
    if (yamlChanged) {
      this.validationError = null;
      this.render(true);
    }
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.dom.contains(event.target as globalThis.Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.setPropertyAreaHovered(false);
    this.dom.removeEventListener('pointerenter', this.handlePropertyAreaPointerEnter);
    this.dom.removeEventListener('pointerleave', this.handlePropertyAreaPointerLeave);
    this.destroyed = true;
    this.view.dom.removeEventListener('flowix:editor-flush-drafts', this.handleFlushDrafts);
    this.view.dom.removeEventListener(EDITOR_EDITABILITY_CHANGE_EVENT, this.handleEditabilityChange);
    this.propertyRows.clear();
    this.disposePropertyImageRoots(true);
    this.finishPropertyDrag();
    if (this.suppressPropertyIconClickTimer !== null) {
      this.dom.ownerDocument.defaultView?.clearTimeout(this.suppressPropertyIconClickTimer);
      this.suppressPropertyIconClickTimer = null;
    }
    this.closePropertyMenu();
    this.closePropertyEditor();
    this.disposeSubscriptions();
  }
}
