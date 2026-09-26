import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { createElement as createReactElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { translate, type I18nKey } from '@/lib/i18n';
import { MEMO_COLORS, MEMO_COLOR_HEX } from '@features/memo/store/memo-store';
import type { MemoColor } from '@/types/memo-item';
import {
  deleteVisibleFrontmatterProperty,
  FrontmatterPropertyError,
  formatFrontmatterPropertyValue,
  isFrontmatterPropertyFlowSequence,
  moveVisibleFrontmatterProperty,
  normalizeTagInput,
  parseVisibleFrontmatter,
  reorderVisibleFrontmatterProperty,
  suggestFrontmatterRepair,
  toFrontmatterPropertyInput,
  updateVisibleFrontmatterProperty,
} from '@features/document/properties/frontmatter-model';
import {
  PROPERTY_ICON_OPTIONS,
  getPropertyIconOption,
} from '@features/document/properties/property-icons';
import {
  CUSTOM_PROPERTY_KINDS,
  PROPERTY_KINDS,
  getAllPresets,
  resolvePropertyPreset,
  type PropertyKind,
} from '@features/document/properties/presets';
import {
  FIXED_PROPERTY_KINDS,
  PROPERTY_DATE_RE,
  resolvePropertyType,
  type PropertyDisplayKind,
} from '@features/document/properties/property-type';
import { DateValueInput } from '@features/document/components/note-properties/date-value-input';
import {
  getCurrentAppLanguage,
  getPropertyFieldPreferences,
  subscribeAppLanguage,
  subscribePropertyFieldPreferences,
} from '@features/preferences/public/runtime-api';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import { isImeKeyboardEvent } from '@/lib/input-method';
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

const PROPERTY_EDIT_POPOVER_WIDTH = 320;
const PROPERTY_EDIT_KINDS = PROPERTY_KINDS;

type PropertyEditKind = PropertyKind;

const PROPERTY_EDIT_KIND_LABEL_KEYS = {
  Text: 'document.properties.type.text',
  Boolean: 'document.properties.type.boolean',
  Number: 'document.properties.type.number',
  Date: 'document.properties.type.date',
  URL: 'document.properties.type.url',
  Icon: 'document.properties.type.icon',
  Select: 'document.properties.type.select',
  MultiSelect: 'document.properties.type.multiSelect',
  Tag: 'document.properties.type.tag',
  Tags: 'document.properties.type.tags',
  Color: 'document.properties.type.color',
} as const;

const FLOWIX_COLOR_LABEL_KEYS: Record<MemoColor, I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

function getPropertyDisplayKind(
  key: string,
  value: unknown,
  isFlowSequence = false,
): PropertyDisplayKind {
  return resolvePropertyType(
    key,
    value,
    isFlowSequence,
    getPropertyFieldPreferences(),
  ).displayKind;
}

function resolveRuntimePropertyPreset(key: string) {
  return resolvePropertyPreset(
    key,
    getPropertyFieldPreferences(),
  );
}

function getPropertyEditKind(
  key: string,
  value: unknown,
  isFlowSequence = false,
): PropertyEditKind {
  const preset = resolveRuntimePropertyPreset(key);
  if (preset) return preset.kind;
  return resolvePropertyType(key, value, isFlowSequence).kind;
}

function createPropertySvgIcon(
  kind: PropertyDisplayKind | 'properties',
): SVGSVGElement {
  if (kind === 'number') return createNumberPropertySvgIcon();
  if (kind === 'color') return createColorPropertySvgIcon();
  if (kind === 'date') return createDatePropertySvgIcon();
  if (kind === 'boolean') return createBooleanPropertySvgIcon();

  const paths: Record<Exclude<PropertyDisplayKind, 'number' | 'date' | 'boolean'> | 'properties', string> = {
    properties: 'M5 6h14M5 12h14M5 18h14M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    text: 'M5 6h14M5 12h14M5 18h9',
    url: 'm9 15 6-6M7 17H6a4 4 0 0 1 0-8h3M17 7h1a4 4 0 0 1 0 8h-3',
    array: 'M8 5v14M16 5v14M5 8h14M5 16h14',
    color: 'M9 16.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z',
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 10h.01M15 10h.01M8.5 14a5 5 0 0 0 7 0',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[kind]);
  svg.append(path);
  return svg;
}

function createDatePropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon');

  const outer = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outer.setAttribute('d', 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z');

  const days = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  days.setAttribute('d', 'M9 13.6h5.6');
  days.setAttribute('stroke-width', '1.8');

  const bindings = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bindings.setAttribute('d', 'M8 3v4M16 3v4');
  bindings.setAttribute('stroke-width', '1.3');

  svg.append(outer, bindings, days);
  return svg;
}

function createBooleanPropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon');

  const outer = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outer.setAttribute('d', 'M7.5 5h9a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 16.5v-9A2.5 2.5 0 0 1 7.5 5z');

  const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  check.setAttribute('d', 'M8 12.5l3 3 5-6');
  check.setAttribute('stroke-width', '1.8');

  svg.append(outer, check);
  return svg;
}

function createColorPropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon', 'frontmatter-property__svg-icon--color');

  const createCircle = (cx: string, cy: string, radius: string, opacity: string) => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', radius);
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '1.8');
    circle.setAttribute('stroke-linecap', 'round');
    circle.setAttribute('opacity', opacity);
    return circle;
  };

  svg.append(createCircle('9', '9', '4.5', '0.48'), createCircle('14.5', '14.5', '5.8', '0.9'));
  return svg;
}

function createNumberPropertySvgIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__svg-icon', 'frontmatter-property__svg-icon--number');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  // A compact 12 mark makes this type distinct from the text/array icons while
  // remaining legible at the small size used by each property row.
  path.setAttribute(
    'd',
    'M5.5 8 7.5 6h1v12M5.5 18h4M12.5 8a2.5 2.5 0 1 1 4.5 1.5l-4.5 9h5',
  );
  svg.append(path);
  return svg;
}

function createPropertyTypeChevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm4 6 4 4 4-4');
  svg.append(path);
  return svg;
}

function createPropertyCheckIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('frontmatter-property__edit-option-check');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm5 12 4 4L19 6');
  svg.append(path);
  return svg;
}

function createTextValue(value: unknown): HTMLElement {
  const text = createElement('span', 'frontmatter-property__value-text');
  // Keep the complete value here; the value cell controls wrapping within its
  // available width instead of silently losing content in the view layer.
  text.textContent = formatFrontmatterPropertyValue(value, Number.POSITIVE_INFINITY);
  return text;
}

function getPropertyEditValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(String).join(', ');
  }
  return toFrontmatterPropertyInput(value);
}

function resizePropertyEditInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

function InlineDateValueInput({
  initialValue,
  onChange,
}: {
  initialValue: string;
  onChange: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return createReactElement(DateValueInput, {
    value,
    onChange: (nextValue: string) => {
      setValue(nextValue);
      onChange(nextValue);
    },
  });
}

type PropertyEditTarget = 'key' | 'value';

interface PropertyEditControl {
  dom: HTMLElement;
  focusTarget: HTMLElement;
  getValue: () => string;
  storageKind: PropertyKind | 'Boolean';
  destroy?: () => void;
}

interface ActivePropertyEdit {
  property: { key: string; value: unknown };
  target: PropertyEditTarget;
  initialValue: string;
  initialKind?: PropertyEditKind;
  kind?: PropertyEditKind;
  popover: HTMLElement;
  control: PropertyEditControl;
}

function convertPropertyEditValue(
  value: string,
  fromKind: PropertyEditKind | undefined,
  toKind: PropertyEditKind,
): string {
  if (fromKind === toKind) return value;
  return value;
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
  private readonly memoId?: string;
  private validationError: string | null = null;
  private activePropertyEdit: ActivePropertyEdit | null = null;
  private activePropertyMenu: HTMLElement | null = null;
  private activePropertyMenuAnchor: HTMLElement | null = null;
  private suppressNextPropertyIconClick = false;
  private suppressPropertyIconClickTimer: number | null = null;
  private propertyDragPreview: HTMLElement | null = null;
  private propertyPointerDrag: PropertyPointerDrag | null = null;
  private readonly unsubscribeSettings: () => void;
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
  private readonly handleAddPropertyRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ memoId?: string }>).detail;
    if (detail?.memoId !== this.memoId || !this.view.editable) return;
    this.addEmptyProperty();
  };

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    memoId?: string,
  ) {
    this.node = node;
    this.memoId = memoId;
    this.dom = createElement('div', 'frontmatter-property-node');
    this.dom.contentEditable = 'false';
    const unsubscribeLanguage = subscribeAppLanguage(() => this.render());
    const unsubscribeProperties = useSettingsStore.subscribe((state, previous) => {
      if (state.propertiesVisible !== previous.propertiesVisible) this.render();
    });
    const unsubscribePropertyPresets = subscribePropertyFieldPreferences(() => this.render());
    this.unsubscribeSettings = () => {
      unsubscribeLanguage();
      unsubscribeProperties();
      unsubscribePropertyPresets();
    };
    this.dom.ownerDocument.addEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    );
    this.dom.ownerDocument.addEventListener(
      'selectstart',
      this.handleDocumentSelectStart,
      true,
    );
    this.dom.ownerDocument.defaultView?.addEventListener(
      'flowix:add-property',
      this.handleAddPropertyRequest,
    );
    this.dom.ownerDocument.defaultView?.addEventListener(
      'pointermove',
      this.handlePropertyPointerMove,
    );
    this.dom.ownerDocument.defaultView?.addEventListener(
      'pointerup',
      this.handlePropertyPointerUp,
    );
    this.dom.ownerDocument.defaultView?.addEventListener(
      'pointercancel',
      this.handlePropertyPointerCancel,
    );
    this.dom.ownerDocument.defaultView?.addEventListener(
      'blur',
      this.handlePropertyWindowBlur,
    );
    this.render();
  }

  private t(key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) {
    return translate(getCurrentAppLanguage(), key, params);
  }

  private errorMessage(error: unknown): string {
    if (!(error instanceof FrontmatterPropertyError)) {
      return error instanceof Error ? error.message : String(error);
    }
    switch (error.code) {
      case 'empty-key':
        return this.t('document.properties.emptyKey');
      case 'duplicate-key':
        return this.t('document.properties.duplicateKey');
      case 'reserved-key':
        return this.t('document.properties.picker.reservedKeyError', { key: 'flowix_key' });
      case 'invalid-tag':
        return this.t('document.properties.invalidTag');
      case 'invalid-color':
        return this.t('document.properties.invalidColor');
      default:
        return error.message;
    }
  }

  private closePropertyEditor() {
    this.activePropertyEdit?.control.destroy?.();
    this.activePropertyEdit?.popover.remove();
    this.activePropertyEdit = null;
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
    this.dom.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
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

  private updatePropertyKey(
    property: { key: string; value: unknown },
    nextKey: string,
  ) {
    try {
      const preset = resolveRuntimePropertyPreset(nextKey);
      const nextYamlContent = updateVisibleFrontmatterProperty(
        String(this.node.attrs.yamlContent ?? ''),
        property.key,
        nextKey,
        getPropertyEditValue(property.value),
        preset?.kind,
      );
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
    if (event.button !== 0) return;
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
    if (!this.view.editable) return;

    // Sorting is intentionally pointer-driven. Keeping the icon non-draggable
    // avoids the browser's native drag image and its competing drag lifecycle.
    dragSource.draggable = false;
    dragSource.setAttribute('aria-grabbed', 'false');
    dragSource.addEventListener('pointerdown', (event) => {
      this.beginPropertyPointerDrag(row, dragSource, propertyKey, event);
    });
  }

  private appendCommonPropertyOptions(
    menu: HTMLElement,
    occupiedKeys: ReadonlySet<string>,
    onSelect: (key: string) => void,
  ) {
    getAllPresets(
      getPropertyFieldPreferences(),
      (key) => this.t(key),
    ).filter((preset) => preset.source === 'builtin' && preset.key !== 'flowix_favorited').forEach((preset) => {
      const option = createElement(
        'button',
        'frontmatter-property__edit-key-option',
        preset.label,
      );
      const alreadyExists = occupiedKeys.has(canonicalizePropertyKey(preset.key));
      option.type = 'button';
      option.dataset.value = preset.key;
      option.setAttribute('role', 'option');
      option.disabled = alreadyExists;
      if (alreadyExists) option.title = this.t('document.properties.commonKey.alreadyExists');
      option.addEventListener('click', (event) => {
        event.preventDefault();
        if (option.disabled) return;
        onSelect(preset.key);
      });
      menu.append(option);
    });
  }

  private appendCustomPropertyOptions(
    menu: HTMLElement,
    occupiedKeys: ReadonlySet<string>,
    onSelect: (key: string) => void,
  ) {
    const customPresets = getAllPresets(
      getPropertyFieldPreferences(),
      (key) => this.t(key),
    ).filter((preset) => preset.source === 'custom');
    customPresets.forEach((preset) => {
      const option = createElement(
        'button',
        'frontmatter-property__edit-key-option',
        preset.label,
      );
      const key = canonicalizePropertyKey(preset.key);
      option.type = 'button';
      option.dataset.value = preset.key;
      option.setAttribute('role', 'option');
      option.title = `${preset.label} (${preset.key})`;
      const alreadyExists = occupiedKeys.has(key);
      option.disabled = alreadyExists;
      if (alreadyExists) option.title = this.t('document.properties.commonKey.alreadyExists');
      option.addEventListener('click', (event) => {
        event.preventDefault();
        if (option.disabled) return;
        onSelect(preset.key);
      });
      menu.append(option);
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
    const menu = createElement('div', 'frontmatter-property__item-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', property.key);

    const occupiedKeys = new Set(
      parsed.properties
        .filter(({ key }) => key !== property.key)
        .map(({ key }) => canonicalizePropertyKey(key)),
    );
    const presetItem = createElement('div', 'frontmatter-property__preset-item');
    const presetButton = createElement(
      'button',
      'frontmatter-property__item-menu-button frontmatter-property__preset-button',
      this.t('document.properties.preset'),
    );
    const presetMenu = createElement('div', 'frontmatter-property__preset-menu');
    presetButton.type = 'button';
    presetButton.setAttribute('role', 'menuitem');
    presetButton.setAttribute('aria-haspopup', 'listbox');
    presetButton.setAttribute('aria-expanded', 'false');
    presetMenu.setAttribute('role', 'listbox');
    presetMenu.setAttribute('aria-label', this.t('document.properties.preset'));
    this.appendCommonPropertyOptions(
      presetMenu,
      occupiedKeys,
      (nextKey) => this.updatePropertyKey(property, nextKey),
    );
    this.appendCustomPropertyOptions(
      presetMenu,
      occupiedKeys,
      (nextKey) => this.updatePropertyKey(property, nextKey),
    );
    const setPresetMenuOpen = (open: boolean) => {
      presetItem.dataset.open = String(open);
      presetButton.setAttribute('aria-expanded', String(open));
    };
    presetItem.addEventListener('mouseenter', () => {
      const itemRect = presetItem.getBoundingClientRect();
      const presetMenuRect = presetMenu.getBoundingClientRect();
      const opensLeft = itemRect.right + presetMenuRect.width > ownerWindow.innerWidth - 8;
      presetMenu.dataset.placement = opensLeft
        ? 'left'
        : 'right';
      setPresetMenuOpen(true);
    });
    presetItem.addEventListener('mouseleave', () => setPresetMenuOpen(false));
    presetItem.addEventListener('focusin', () => setPresetMenuOpen(true));
    presetItem.addEventListener('focusout', (event) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof globalThis.Node) || !presetItem.contains(nextTarget)) {
        setPresetMenuOpen(false);
      }
    });
    presetButton.addEventListener('click', (event) => {
      event.preventDefault();
      setPresetMenuOpen(presetItem.dataset.open !== 'true');
    });
    presetItem.append(presetButton, presetMenu);
    menu.append(presetItem);

    const addAction = (
      action: 'up' | 'down' | 'delete',
      labelKey: Parameters<typeof translate>[1],
      disabled = false,
    ) => {
      const button = createElement('button', 'frontmatter-property__item-menu-button', this.t(labelKey));
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = disabled;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        if (button.disabled) return;
        this.updatePropertyStructure(property.key, action);
      });
      menu.append(button);
    };

    addAction('up', 'document.properties.moveUp', propertyIndex <= 0);
    addAction(
      'down',
      'document.properties.moveDown',
      propertyIndex < 0 || propertyIndex >= parsed.properties.length - 1,
    );
    addAction('delete', 'document.properties.deleteProperty');

    const anchorRect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${Math.max(8, anchorRect.left)}px`;
    menu.style.top = `${Math.max(8, anchorRect.bottom + 4)}px`;
    ownerDocument.body.append(menu);
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > ownerWindow.innerWidth - 8) {
      menu.style.left = `${Math.max(8, ownerWindow.innerWidth - menuRect.width - 8)}px`;
    }
    if (menuRect.bottom > ownerWindow.innerHeight - 8) {
      menu.style.top = `${Math.max(8, anchorRect.top - menuRect.height - 4)}px`;
    }
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
    const activeEdit = this.activePropertyEdit;
    if (!activeEdit) return;

    const nextInputValue = activeEdit.control.getValue();
    const nextKeyInput = activeEdit.target === 'key'
      ? nextInputValue
      : activeEdit.property.key;
    const nextValueInput = activeEdit.target === 'value'
      && typeof activeEdit.property.value === 'boolean'
      ? nextInputValue.trim()
      : activeEdit.target === 'value'
        ? nextInputValue
        : getPropertyEditValue(activeEdit.property.value);
    const kind = activeEdit.target === 'value' ? activeEdit.kind : undefined;
    const storageKind = activeEdit.target === 'value'
      ? activeEdit.control.storageKind
      : undefined;
    this.closePropertyEditor();
    if (
      activeEdit.target === 'key'
        ? nextKeyInput === activeEdit.initialValue
        : nextValueInput === activeEdit.initialValue && kind === activeEdit.initialKind
    ) return;

    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        String(this.node.attrs.yamlContent ?? ''),
        activeEdit.property.key,
        nextKeyInput,
        nextValueInput,
        storageKind,
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

  private updateBooleanProperty(
    property: { key: string; value: unknown },
    nextValue: boolean,
  ) {
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

  private openPropertyEditor(
    property: { key: string; value: unknown },
    anchor: HTMLElement,
    target: PropertyEditTarget,
  ) {
    if (!this.view.editable) return;
    this.closePropertyEditor();

    const ownerDocument = this.dom.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popover = createElement('div', 'frontmatter-property__edit-popover');
    const isFlowSequence = isFrontmatterPropertyFlowSequence(
      String(this.node.attrs.yamlContent ?? ''),
      property.key,
    );
    const initialKind = target === 'value'
      ? getPropertyEditKind(property.key, property.value, isFlowSequence)
      : undefined;
    const initialValue = target === 'key'
      ? property.key
      : getPropertyEditValue(property.value);

    popover.style.position = 'fixed';
    popover.style.left = `${anchorRect.left}px`;
    popover.style.top = `${anchorRect.top}px`;
    const availableWidth = Math.max(180, ownerWindow.innerWidth - anchorRect.left - 16);
    popover.style.width = `${Math.min(
      PROPERTY_EDIT_POPOVER_WIDTH,
      availableWidth,
    )}px`;

    let locallyComposing = false;
    const handleKeyDown = (event: KeyboardEvent) => {
      const keyboardEvent = event;
      if (isImeKeyboardEvent(keyboardEvent, locallyComposing)) return;
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        this.closePropertyEditor();
        return;
      }
      if (
        keyboardEvent.key === 'Enter'
        && (target === 'key' || keyboardEvent.metaKey || keyboardEvent.ctrlKey)
      ) {
        keyboardEvent.preventDefault();
        this.savePropertyEdit();
      }
    };

    const focusControl = (control: PropertyEditControl) => {
      control.focusTarget.focus();
      if (
        control.focusTarget instanceof HTMLInputElement
        && control.focusTarget.type === 'text'
      ) {
        control.focusTarget.setSelectionRange(
          control.focusTarget.value.length,
          control.focusTarget.value.length,
        );
      }
      if (control.focusTarget instanceof HTMLTextAreaElement) {
        resizePropertyEditInput(control.focusTarget);
        control.focusTarget.setSelectionRange(
          control.focusTarget.value.length,
          control.focusTarget.value.length,
        );
      }
    };

    const createPlainTextControl = (
      value: string,
      storageKind: PropertyKind = 'Text',
    ): PropertyEditControl => {
      const textarea = createElement('textarea', 'frontmatter-property__edit-input');
      textarea.value = value;
      textarea.rows = 1;
      textarea.spellcheck = false;
      textarea.wrap = 'soft';
      textarea.setAttribute('aria-label', property.key);
      textarea.setAttribute('data-property-key', property.key);
      textarea.addEventListener('input', () => resizePropertyEditInput(textarea));
      textarea.addEventListener('keydown', handleKeyDown);
      return {
        dom: textarea,
        focusTarget: textarea,
        getValue: () => textarea.value,
        storageKind,
      };
    };

    const createSelectControl = (value: string): PropertyEditControl => {
      const configuredOptions = resolveRuntimePropertyPreset(property.key)?.options ?? [];
      const options = [...new Set([
        ...configuredOptions,
        ...(value && !configuredOptions.includes(value) ? [value] : []),
      ])];
      if (options.length === 0) return createPlainTextControl(value);

      const optionControl = createElement('div', 'frontmatter-property__edit-option-menu');
      const trigger = createElement('button', 'frontmatter-property__edit-input frontmatter-property__edit-option-trigger');
      const menu = createElement('div', 'frontmatter-property__edit-option-list');
      let selectedValue = value;
      trigger.type = 'button';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-label', property.key);
      menu.setAttribute('role', 'listbox');
      menu.hidden = true;

      const renderOptions = () => {
        trigger.textContent = selectedValue || this.t('document.properties.select.placeholder');
        menu.replaceChildren();
        options.forEach((optionValue) => {
          const option = createElement('button', 'frontmatter-property__edit-option-item', optionValue);
          option.type = 'button';
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', String(selectedValue === optionValue));
          if (selectedValue === optionValue) {
            option.append(createPropertyCheckIcon());
          }
          option.addEventListener('click', () => {
            selectedValue = optionValue;
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            renderOptions();
            trigger.focus();
          });
          menu.append(option);
        });
      };
      trigger.addEventListener('click', () => {
        menu.hidden = !menu.hidden;
        trigger.setAttribute('aria-expanded', String(!menu.hidden));
      });
      trigger.addEventListener('keydown', handleKeyDown);
      menu.addEventListener('keydown', handleKeyDown);
      renderOptions();
      optionControl.append(trigger, menu);
      return {
        dom: optionControl,
        focusTarget: trigger,
        getValue: () => selectedValue,
        storageKind: 'Select',
      };
    };

    const createControl = (kind: PropertyEditKind, value: string): PropertyEditControl => {
      if (kind === 'Boolean') {
        const label = createElement('label', 'frontmatter-property__edit-checkbox-label');
        const checkbox = createElement('input', 'frontmatter-property__edit-checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = value.trim() === 'true';
        checkbox.setAttribute('aria-label', property.key);
        checkbox.setAttribute('data-property-key', property.key);
        checkbox.addEventListener('keydown', handleKeyDown);
        label.append(checkbox);
        return {
          dom: label,
          focusTarget: checkbox,
          getValue: () => String(checkbox.checked),
          storageKind: 'Boolean',
        };
      }

      if (kind === 'Number') {
        const numberControl = createElement('div', 'frontmatter-property__edit-number-control');
        const input = createElement('input', 'frontmatter-property__edit-input');
        input.type = 'number';
        input.step = '1';
        input.inputMode = 'numeric';
        input.value = value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '');
        input.spellcheck = false;
        input.setAttribute('aria-label', property.key);
        input.setAttribute('data-property-key', property.key);
        input.setAttribute('inputmode', 'numeric');
        input.addEventListener('input', () => {
          const negative = input.value.startsWith('-');
          const digits = input.value.replace(/\D/g, '');
          const nextValue = negative ? `-${digits}` : digits;
          if (input.value !== nextValue) input.value = nextValue;
        });
        input.addEventListener('keydown', (event) => {
          if (event.key.length === 1) {
            if (
              event.key === '-'
              && (
                input.value.includes('-')
                || (input.selectionStart !== null && input.selectionStart !== 0)
              )
            ) {
              event.preventDefault();
              return;
            }
            if (!/\d/.test(event.key) && event.key !== '-') {
              event.preventDefault();
              return;
            }
          }
          handleKeyDown(event);
        });
        const stepper = createElement('div', 'frontmatter-property__edit-number-stepper');
        const addStepButton = createElement('button', 'frontmatter-property__edit-number-step', '+');
        const subtractStepButton = createElement('button', 'frontmatter-property__edit-number-step', '−');
        addStepButton.type = 'button';
        subtractStepButton.type = 'button';
        addStepButton.setAttribute('aria-label', 'Increase value');
        subtractStepButton.setAttribute('aria-label', 'Decrease value');
        const stepValue = (direction: 'up' | 'down') => {
          if (direction === 'up') input.stepUp();
          else input.stepDown();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        };
        addStepButton.addEventListener('click', () => stepValue('up'));
        subtractStepButton.addEventListener('click', () => stepValue('down'));
        stepper.append(addStepButton, subtractStepButton);
        numberControl.append(input, stepper);
        return {
          dom: numberControl,
          focusTarget: input,
          getValue: () => input.value,
          storageKind: 'Number',
        };
      }

      if (kind === 'Date') {
        const dateControl = createElement('div', 'frontmatter-property__edit-date');
        dateControl.tabIndex = -1;
        dateControl.setAttribute('data-property-key', property.key);
        let dateValue = PROPERTY_DATE_RE.test(value) ? value : '';
        const root: Root = createRoot(dateControl);
        root.render(createReactElement(InlineDateValueInput, {
          initialValue: dateValue,
          onChange: (nextValue: string) => {
            dateValue = nextValue;
          },
        }));
        dateControl.addEventListener('keydown', handleKeyDown);
        return {
          dom: dateControl,
          focusTarget: dateControl,
          getValue: () => dateValue,
          storageKind: 'Date',
          destroy: () => root.unmount(),
        };
      }

      if (kind === 'Icon') {
        const iconControl = createElement('div', 'frontmatter-property__edit-icon');
        let iconValue = value.trim().replace(/\.svg$/i, '');
        const trigger = createElement('button', 'frontmatter-property__edit-icon-trigger');
        const menu = createElement('div', 'frontmatter-property__edit-icon-menu');
        trigger.type = 'button';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', property.key);
        menu.hidden = true;

        const closeMenu = () => {
          menu.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        };
        const renderTrigger = () => {
          trigger.replaceChildren();
          const iconBox = createElement('span', 'frontmatter-property__edit-icon-box');
          const selected = getPropertyIconOption(iconValue);
          if (!selected) iconBox.classList.add('frontmatter-property__edit-icon-box--empty');
          if (selected) {
            const image = createElement('img', 'frontmatter-property__edit-icon-image');
            image.src = selected.src;
            image.alt = '';
            image.draggable = false;
            image.title = selected.label;
            trigger.title = selected.label;
            iconBox.append(image);
          } else {
            trigger.title = '';
            iconBox.append(createElement('span', 'frontmatter-property__edit-icon-placeholder'));
          }
          trigger.append(iconBox);
          if (iconValue) {
            const clear = createElement('span', 'frontmatter-property__edit-icon-clear', '×');
            clear.setAttribute('role', 'button');
            clear.tabIndex = -1;
            clear.setAttribute('aria-label', this.t('document.properties.icon.clear'));
            clear.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              iconValue = '';
              renderTrigger();
              trigger.focus();
            });
            trigger.append(clear);
          }
        };

        menu.setAttribute('role', 'listbox');
        PROPERTY_ICON_OPTIONS.forEach((option) => {
          const item = createElement('button', 'frontmatter-property__edit-icon-option');
          item.type = 'button';
          item.dataset.value = option.value;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-label', option.label);
          item.setAttribute('aria-selected', String(option.value === iconValue));
          const image = createElement('img', 'frontmatter-property__edit-icon-image');
          image.src = option.src;
          image.alt = '';
          image.draggable = false;
          item.append(image);
          item.addEventListener('click', () => {
            iconValue = option.value;
            menu.querySelectorAll<HTMLElement>('[role="option"]').forEach((entry) => {
              entry.setAttribute('aria-selected', String(entry === item));
            });
            renderTrigger();
            closeMenu();
            trigger.focus();
          });
          menu.append(item);
        });

        trigger.addEventListener('click', () => {
          const open = menu.hidden;
          menu.hidden = !open;
          trigger.setAttribute('aria-expanded', String(open));
        });
        trigger.addEventListener('keydown', handleKeyDown);
        menu.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          closeMenu();
          trigger.focus();
        });
        renderTrigger();
        iconControl.append(trigger, menu);
        return {
          dom: iconControl,
          focusTarget: trigger,
          getValue: () => iconValue,
          storageKind: 'Icon',
        };
      }

      if (
        kind === 'Color'
      ) {
        const colorControl = createElement('div', 'frontmatter-property__edit-colors');
        colorControl.tabIndex = 0;
        colorControl.setAttribute('role', 'group');
        colorControl.setAttribute('aria-label', this.t('document.color.button'));
        const selected = new Set<MemoColor>(
          value
            .split(',')
            .map((item) => item.trim())
            .filter((item): item is MemoColor => MEMO_COLORS.includes(item as MemoColor)),
        );

        const renderColors = () => {
          colorControl.replaceChildren();
          const clear = createElement('button', 'frontmatter-property__edit-color-clear');
          clear.type = 'button';
          clear.setAttribute('aria-label', this.t('document.color.clear'));
          clear.setAttribute('aria-pressed', String(selected.size === 0));
          clear.addEventListener('click', () => {
            selected.clear();
            renderColors();
          });
          colorControl.append(clear);

          MEMO_COLORS.forEach((color) => {
            const option = createElement(
              'button',
              'frontmatter-property__edit-color-option',
            );
            const isSelected = selected.has(color);
            option.type = 'button';
            option.dataset.value = color;
            option.setAttribute('aria-label', this.t(FLOWIX_COLOR_LABEL_KEYS[color]));
            option.setAttribute('aria-pressed', String(isSelected));
            option.title = this.t(FLOWIX_COLOR_LABEL_KEYS[color]);
            option.append(createElement('span', 'frontmatter-property__edit-color-swatch'));
            option.style.setProperty('--frontmatter-edit-color', MEMO_COLOR_HEX[color]);
            if (isSelected) option.dataset.selected = 'true';
            option.addEventListener('click', () => {
              if (selected.has(color)) selected.delete(color);
              else selected.add(color);
              renderColors();
            });
            colorControl.append(option);
          });
        };

        colorControl.addEventListener('keydown', handleKeyDown);
        renderColors();
        return {
          dom: colorControl,
          focusTarget: colorControl,
          getValue: () => MEMO_COLORS.filter((color) => selected.has(color)).join(', '),
          storageKind: 'Color',
        };
      }

      if (kind === 'MultiSelect') {
        const configuredOptions = resolveRuntimePropertyPreset(property.key)?.options ?? [];
        if (configuredOptions.length > 0) {
          const optionControl = createElement('div', 'frontmatter-property__edit-option-menu');
          const trigger = createElement('button', 'frontmatter-property__edit-input frontmatter-property__edit-option-trigger');
          const menu = createElement('div', 'frontmatter-property__edit-option-list');
          const selected = new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
          trigger.type = 'button';
          trigger.setAttribute('aria-haspopup', 'listbox');
          trigger.setAttribute('aria-expanded', 'false');
          trigger.setAttribute('aria-label', property.key);
          menu.setAttribute('role', 'listbox');
          menu.hidden = true;

          const renderOptions = () => {
            trigger.textContent = selected.size > 0
              ? [...selected].join(', ')
              : this.t('document.properties.select.placeholder');
            menu.replaceChildren();
            configuredOptions.forEach((optionValue) => {
              const option = createElement('button', 'frontmatter-property__edit-option-item', optionValue);
              option.type = 'button';
              option.setAttribute('role', 'option');
              option.setAttribute('aria-selected', String(selected.has(optionValue)));
              if (selected.has(optionValue)) {
                option.append(createPropertyCheckIcon());
              }
              option.addEventListener('click', () => {
                if (selected.has(optionValue)) selected.delete(optionValue);
                else selected.add(optionValue);
                renderOptions();
              });
              menu.append(option);
            });
          };
          trigger.addEventListener('click', () => {
            menu.hidden = !menu.hidden;
            trigger.setAttribute('aria-expanded', String(!menu.hidden));
          });
          trigger.addEventListener('keydown', handleKeyDown);
          menu.addEventListener('keydown', handleKeyDown);
          renderOptions();
          optionControl.append(trigger, menu);
          return {
            dom: optionControl,
            focusTarget: trigger,
            getValue: () => [...selected].join(', '),
            storageKind: 'MultiSelect',
          };
        }
      }

      if (kind === 'Select') {
        const hasConfiguredOptions = (resolveRuntimePropertyPreset(property.key)?.options?.length ?? 0) > 0;
        if (typeof property.value !== 'boolean' && hasConfiguredOptions) {
          return createSelectControl(value);
        }
        const label = createElement('label', 'frontmatter-property__edit-checkbox-label');
        const checkbox = createElement('input', 'frontmatter-property__edit-checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = value.trim() === 'true';
        checkbox.setAttribute('aria-label', property.key);
        checkbox.setAttribute('data-property-key', property.key);
        checkbox.addEventListener('keydown', handleKeyDown);
        label.append(checkbox);
        return {
          dom: label,
          focusTarget: checkbox,
          getValue: () => String(checkbox.checked),
          storageKind: 'Boolean',
        };
      }

      if (kind === 'MultiSelect' || kind === 'Tag' || kind === 'Tags') {
        const tagControl = createElement('div', 'frontmatter-property__edit-tags');
        const chips = createElement('div', 'frontmatter-property__edit-tags-chips');
        const input = createElement(
          'input',
          'frontmatter-property__edit-input frontmatter-property__edit-tags-input',
        );
        const isNoteTags = canonicalizePropertyKey(property.key) === 'tags';
        const normalizeInput = (item: string) => (
          isNoteTags ? normalizeTagInput(item) : item.trim()
        );
        let tags = value.split(',').map(normalizeInput).filter(Boolean);
        let activeTagIndex: number | null = null;

        const renderTags = () => {
          chips.replaceChildren();
          tags.forEach((tag, index) => {
            const chip = createElement(
              'span',
              `frontmatter-property__edit-tag-chip${isNoteTags ? '' : ' frontmatter-property__edit-tag-chip--plain'}`,
            );
            if (activeTagIndex === index) chip.dataset.keyboardSelected = 'true';
            if (isNoteTags) {
              chip.append(
                createElement('span', 'tag-node-prefix', '#'),
                createElement('span', 'tag-node-content', tag),
              );
            } else {
              chip.textContent = tag;
            }
            chips.append(chip);
          });
        };

        input.type = 'text';
        input.spellcheck = false;
        input.setAttribute('aria-label', this.t('document.properties.tagInputPlaceholder'));
        input.setAttribute('data-property-key', property.key);
        input.addEventListener('compositionstart', () => {
          locallyComposing = true;
        });
        input.addEventListener('compositionend', () => {
          locallyComposing = false;
        });
        input.addEventListener('input', () => {
          activeTagIndex = null;
          renderTags();
        });
        input.addEventListener('keydown', (event) => {
          if (isImeKeyboardEvent(event, locallyComposing)) return;
          if (event.key === 'ArrowLeft' && input.value.length === 0) {
            event.preventDefault();
            if (tags.length === 0) return;
            activeTagIndex = activeTagIndex === null
              ? tags.length - 1
              : Math.max(0, activeTagIndex - 1);
            renderTags();
            return;
          }
          if (event.key === 'ArrowRight' && activeTagIndex !== null) {
            event.preventDefault();
            activeTagIndex += 1;
            if (activeTagIndex >= tags.length) {
              activeTagIndex = null;
              input.focus();
              input.setSelectionRange(input.value.length, input.value.length);
            }
            renderTags();
            return;
          }
          if (event.key === 'Backspace' && input.value.length === 0 && tags.length > 0) {
            event.preventDefault();
            const indexToRemove = activeTagIndex ?? tags.length - 1;
            tags = tags.filter((_, index) => index !== indexToRemove);
            activeTagIndex = tags.length === 0
              ? null
              : Math.min(indexToRemove, tags.length - 1);
            renderTags();
            return;
          }
          if (
            event.key !== 'Enter'
            && event.key !== ','
          ) {
            handleKeyDown(event);
            return;
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            handleKeyDown(event);
            return;
          }
          const draft = normalizeInput(input.value);
          if (!draft) return;
          event.preventDefault();
          if (!tags.includes(draft)) tags = [...tags, draft];
          input.value = '';
          activeTagIndex = null;
          renderTags();
        });
        renderTags();
        tagControl.append(chips, input);
        return {
          dom: tagControl,
          focusTarget: input,
          getValue: () => [...tags, normalizeInput(input.value)].filter(Boolean).join(', '),
          storageKind: kind,
        };
      }

      return createPlainTextControl(value, kind === 'URL' ? 'URL' : 'Text');
    };

    let control: PropertyEditControl;
    if (target === 'key') {
      const input = createElement('input', 'frontmatter-property__edit-input');

      input.value = initialValue;
      input.spellcheck = false;
      input.setAttribute('aria-label', 'key');
      input.setAttribute('data-property-key', property.key);
      input.addEventListener('compositionstart', () => {
        locallyComposing = true;
      });
      input.addEventListener('compositionend', () => {
        locallyComposing = false;
      });
      input.addEventListener('keydown', handleKeyDown);
      control = {
        dom: input,
        focusTarget: input,
        getValue: () => input.value,
        storageKind: 'Text',
      };
    } else {
      control = createControl(initialKind ?? 'Text', initialValue);
    }

    popover.addEventListener('focusout', (event) => {
      const nextTarget = event.relatedTarget;
      const nextTargetElement = nextTarget instanceof Element ? nextTarget : null;
      if (
        !(nextTarget instanceof globalThis.Node)
        || popover.contains(nextTarget)
        || nextTargetElement?.closest('.frontmatter-property__date-picker-popover')
      ) return;
      queueMicrotask(() => {
        if (
          this.activePropertyEdit?.popover === popover
          && !popover.contains(ownerDocument.activeElement)
        ) {
          this.savePropertyEdit();
        }
      });
    });
    if (initialKind) {
      const typeRow = createElement('div', 'frontmatter-property__edit-type-row');
      const typeTrigger = createElement('button', 'frontmatter-property__edit-type-trigger');
      const propertyPreset = resolvePropertyPreset(
        property.key,
        getPropertyFieldPreferences(),
      );
      const isFixedPropertyKind = target === 'value'
        && (
          FIXED_PROPERTY_KINDS[canonicalizePropertyKey(property.key)] !== undefined
          || propertyPreset !== null
        );
      typeTrigger.type = 'button';
      typeTrigger.disabled = isFixedPropertyKind;
      typeTrigger.setAttribute('aria-haspopup', 'listbox');
      typeTrigger.setAttribute('aria-expanded', 'false');
      typeTrigger.setAttribute('aria-disabled', String(isFixedPropertyKind));
      typeTrigger.setAttribute('aria-label', this.t('document.properties.typeColumn'));
      const typeLabel = createElement(
        'span',
        'frontmatter-property__edit-type-label',
        this.t(PROPERTY_EDIT_KIND_LABEL_KEYS[initialKind]),
      );
      if (isFixedPropertyKind) {
        typeLabel.append(createElement(
          'span',
          'frontmatter-property__edit-type-locked',
          `（${this.t('document.properties.presetPropertyLocked')}）`,
        ));
      }
      const typeChevron = createElement('span', 'frontmatter-property__edit-type-chevron');
      typeChevron.append(createPropertyTypeChevron());
      typeTrigger.append(typeLabel, typeChevron);

      const typeMenu = createElement('div', 'frontmatter-property__edit-type-menu');
      typeMenu.hidden = true;
      typeMenu.setAttribute('role', 'listbox');
      const availablePropertyEditKinds = propertyPreset?.source === 'builtin'
        ? PROPERTY_EDIT_KINDS
        : CUSTOM_PROPERTY_KINDS;
      const closeTypeMenu = () => {
        typeMenu.hidden = true;
        typeTrigger.setAttribute('aria-expanded', 'false');
      };
      control.focusTarget.addEventListener('focus', closeTypeMenu);
      availablePropertyEditKinds.forEach((kind) => {
        const option = createElement(
          'button',
          'frontmatter-property__edit-type-option',
          this.t(PROPERTY_EDIT_KIND_LABEL_KEYS[kind]),
        );
        option.type = 'button';
        option.dataset.value = kind;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(kind === initialKind));
        option.addEventListener('click', () => {
          const activeEdit = this.activePropertyEdit;
          if (activeEdit?.popover !== popover || activeEdit.target !== 'value') return;
          const nextValue = convertPropertyEditValue(
            activeEdit.control.getValue(),
            activeEdit.kind,
            kind,
          );
          const nextControl = createControl(kind, nextValue);
          activeEdit.kind = kind;
          activeEdit.control.destroy?.();
          activeEdit.control.dom.replaceWith(nextControl.dom);
          activeEdit.control = nextControl;
          typeLabel.textContent = this.t(PROPERTY_EDIT_KIND_LABEL_KEYS[kind]);
          typeMenu.querySelectorAll<HTMLElement>('[role="option"]').forEach((item) => {
            item.setAttribute('aria-selected', String(item === option));
          });
          closeTypeMenu();
          focusControl(nextControl);
        });
        typeMenu.append(option);
      });
      typeTrigger.addEventListener('click', () => {
        const open = typeMenu.hidden;
        typeMenu.hidden = !open;
        typeTrigger.setAttribute('aria-expanded', String(open));
      });
      typeTrigger.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (!typeMenu.hidden) {
          closeTypeMenu();
          return;
        }
        this.closePropertyEditor();
      });
      typeMenu.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        closeTypeMenu();
        typeTrigger.focus();
      });
      typeRow.append(typeTrigger, typeMenu);
      popover.append(typeRow);
    }
    popover.append(control.dom);
    ownerDocument.body.append(popover);
    this.activePropertyEdit = {
      property,
      target,
      initialValue,
      initialKind,
      kind: initialKind,
      popover,
      control,
    };
    focusControl(control);
  }

  private renderPropertyValue(
    property: { key: string; value: unknown },
    isFlowSequence = false,
  ): HTMLElement {
    const valueContainer = createElement('div', 'frontmatter-property__display-value');
    const kind = getPropertyDisplayKind(property.key, property.value, isFlowSequence);

    if (
      property.value === ''
      || property.value === null
      || property.value === undefined
      || (Array.isArray(property.value) && property.value.length === 0)
    ) {
      valueContainer.append(createElement(
        'span',
        'frontmatter-property__value-text frontmatter-property__value-text--fallback',
        this.t('document.properties.notSet'),
      ));
      return valueContainer;
    }

    if (kind === 'boolean') {
      const checkbox = createElement('input', 'frontmatter-property__value-checkbox');
      checkbox.type = 'checkbox';
      checkbox.checked = property.value === true;
      checkbox.disabled = !this.view.editable;
      checkbox.setAttribute('aria-label', property.key);
      checkbox.setAttribute('data-property-key', property.key);
      checkbox.setAttribute('data-property-type', 'Select');
      checkbox.addEventListener('change', () => {
        this.updateBooleanProperty(property, checkbox.checked);
      });
      valueContainer.classList.add('frontmatter-property__display-value--checkbox');
      valueContainer.append(checkbox);
      return valueContainer;
    }

    if (kind === 'array' || kind === 'color') {
      if (!Array.isArray(property.value)) {
        valueContainer.append(createTextValue(property.value));
        return valueContainer;
      }
      const values = Array.isArray(property.value) ? property.value : [];
      if (values.length === 0) {
        valueContainer.append(createTextValue('[]'));
        return valueContainer;
      }

      if (kind === 'color') {
        const colorDots = createElement('div', 'frontmatter-property__value-color-dots');
        values.forEach((item) => {
          const color = String(item).trim();
          if (!MEMO_COLORS.includes(color as MemoColor)) return;
          const dot = createElement('span', 'frontmatter-property__value-color-dot');
          const label = this.t(FLOWIX_COLOR_LABEL_KEYS[color as MemoColor]);
          dot.dataset.value = color;
          dot.setAttribute('role', 'img');
          dot.setAttribute('aria-label', label);
          dot.title = label;
          dot.style.setProperty('--frontmatter-color', MEMO_COLOR_HEX[color as MemoColor]);
          colorDots.append(dot);
        });
        valueContainer.append(colorDots);
        return valueContainer;
      }

      const isNoteTags = canonicalizePropertyKey(property.key) === 'tags';
      const isTagValues = values.every(
        (item) => resolvePropertyType('', item).displayKind === 'text',
      );
      const chips = createElement(
        'div',
        `frontmatter-property__value-chips${isTagValues ? ' frontmatter-property__value-chips--tag-values' : ''}`,
      );
      values.forEach((item) => {
        const displayValue = formatFrontmatterPropertyValue(item, 32);
        const itemDisplayKind = resolvePropertyType('', item).displayKind;
        const chip = createElement(
          'span',
          `${isNoteTags ? 'tag-node ' : ''}frontmatter-property__value-chip${itemDisplayKind === 'text' ? '' : ' frontmatter-property__value-chip--typed'}`,
        );
        if (isNoteTags) {
          chip.append(
            createElement('span', 'tag-node-prefix', '#'),
            createElement('span', 'tag-node-content', displayValue),
          );
        } else {
          chip.textContent = displayValue;
        }
        chip.title = formatFrontmatterPropertyValue(item, Number.POSITIVE_INFINITY);
        chips.append(chip);
      });
      valueContainer.append(chips);
      return valueContainer;
    }

    if (kind === 'icon') {
      const iconOption = getPropertyIconOption(String(property.value ?? ''));
      if (iconOption) {
        const image = document.createElement('img');
        image.className = 'frontmatter-property__value-icon';
        image.src = iconOption.src;
        image.alt = iconOption.label;
        image.title = iconOption.label;
        valueContainer.append(image);
        return valueContainer;
      }
    }

    if (kind === 'url' && typeof property.value === 'string') {
      const link = createElement('a', 'frontmatter-property__value-text frontmatter-property__value-text--url', property.value);
      link.href = property.value;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.title = property.value;
      valueContainer.append(link);
      return valueContainer;
    }

    valueContainer.append(createTextValue(property.value));
    return valueContainer;
  }

  private bindPropertyEdit(
    cell: HTMLElement,
    property: { key: string; value: unknown },
    target: PropertyEditTarget,
  ) {
    if (!this.view.editable) return;
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.addEventListener('click', (event) => {
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
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.openPropertyEditor(property, cell, target);
    });
  }

  private renderPropertyRow(
    property: { key: string; value: unknown },
    isFlowSequence = false,
  ): HTMLElement {
    const kind = getPropertyDisplayKind(property.key, property.value, isFlowSequence);
    const row = createElement('div', 'frontmatter-property__display');
    row.dataset.propertyKey = property.key;

    const icon = createElement(
      'span',
      `frontmatter-property__type-icon frontmatter-property__type-icon--${kind}`,
    );
    if (this.view.editable) {
      icon.tabIndex = 0;
      icon.setAttribute('role', 'button');
      icon.setAttribute('aria-haspopup', 'menu');
      icon.setAttribute('aria-expanded', 'false');
      icon.setAttribute('aria-label', property.key);
      icon.addEventListener('click', () => {
        if (this.consumeSuppressedPropertyIconClick()) return;
        this.openPropertyMenu(property, icon);
      });
      icon.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.openPropertyMenu(property, icon);
      });
    }
    icon.append(createPropertySvgIcon(kind));

    const key = createElement('span', 'frontmatter-property__display-key');
    key.title = property.key;
    const preset = resolvePropertyPreset(
      property.key,
      getPropertyFieldPreferences(),
      (labelKey) => this.t(labelKey),
    );
    key.append(createElement(
      'span',
      'frontmatter-property__key',
      preset?.label ?? property.key,
    ));
    const value = this.renderPropertyValue(property, isFlowSequence);

    this.bindPropertyEdit(key, property, 'key');
    this.bindPropertyEdit(value, property, 'value');
    this.bindPropertyDrag(row, icon, property.key);

    row.append(icon, key, value);
    return row;
  }

  private addEmptyProperty() {
    const yamlContent = String(this.node.attrs.yamlContent ?? '');
    const parsed = parseVisibleFrontmatter(yamlContent);
    const existingKeys = new Set(Object.keys(parsed.data));
    let index = 1;
    let nextKey = `key${index}`;
    while (existingKeys.has(nextKey)) {
      index += 1;
      nextKey = `key${index}`;
    }

    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        yamlContent,
        null,
        nextKey,
        '',
        'Text',
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

  private render() {
    this.closePropertyMenu();
    this.closePropertyEditor();
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    if (!useSettingsStore.getState().propertiesVisible) {
      this.dom.hidden = true;
      this.dom.replaceChildren();
      return;
    }
    this.dom.hidden = false;
    const container = createElement('div', 'frontmatter-property');

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
          window.dispatchEvent(new CustomEvent('flowix:view-source-mode'));
        });
        container.append(source);
      }
    } else {
      if (parsed.properties.length > 0) {
        const list = createElement('div', 'frontmatter-property__list');
        parsed.properties.forEach((property) => {
          list.append(this.renderPropertyRow(
            property,
            isFrontmatterPropertyFlowSequence(String(this.node.attrs.yamlContent ?? ''), property.key),
          ));
        });
        if (this.validationError) {
          const validation = createElement(
            'span',
            'frontmatter-property__validation',
            this.validationError,
          );
          validation.title = this.validationError;
          list.append(validation);
        }
        container.append(list);
      }
    }

    this.dom.replaceChildren(container);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const yamlChanged = node.attrs.yamlContent !== this.node.attrs.yamlContent;
    this.node = node;
    if (yamlChanged) this.validationError = null;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.dom.contains(event.target as globalThis.Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.finishPropertyDrag();
    if (this.suppressPropertyIconClickTimer !== null) {
      this.dom.ownerDocument.defaultView?.clearTimeout(this.suppressPropertyIconClickTimer);
      this.suppressPropertyIconClickTimer = null;
    }
    this.closePropertyMenu();
    this.closePropertyEditor();
    this.dom.ownerDocument.removeEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    );
    this.dom.ownerDocument.removeEventListener(
      'selectstart',
      this.handleDocumentSelectStart,
      true,
    );
    this.dom.ownerDocument.defaultView?.removeEventListener(
      'flowix:add-property',
      this.handleAddPropertyRequest,
    );
    this.dom.ownerDocument.defaultView?.removeEventListener(
      'pointermove',
      this.handlePropertyPointerMove,
    );
    this.dom.ownerDocument.defaultView?.removeEventListener(
      'pointerup',
      this.handlePropertyPointerUp,
    );
    this.dom.ownerDocument.defaultView?.removeEventListener(
      'pointercancel',
      this.handlePropertyPointerCancel,
    );
    this.dom.ownerDocument.defaultView?.removeEventListener(
      'blur',
      this.handlePropertyWindowBlur,
    );
    this.unsubscribeSettings();
  }
}
