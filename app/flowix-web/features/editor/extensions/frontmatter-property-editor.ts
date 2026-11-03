import { createElement as createReactElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { translate, type I18nKey } from '@/lib/i18n';
import { getPropertyTypeDefinition } from '@/lib/property-types';
import { stableTextHue } from '@/lib/color';
import { NOTE_COLORS, NOTE_COLOR_HEX } from '@features/memo/store/note-store';
import type { NoteColor } from '@/types/note-item';
import { isFrontmatterPropertyFlowSequence, normalizeTagInput, toFrontmatterPropertyInput } from '@features/document/properties/frontmatter-model';
import { getPropertyIconOption } from '@features/document/public/property-display-api';
import { getAllPresets, PROPERTY_KINDS, resolvePropertyPreset, type PropertyKind } from '@features/document/properties/presets';
import { PROPERTY_DATE_RE, resolvePropertyType } from '@features/document/properties/property-type';
import { DateValueInput } from '@features/document/components/note-properties/date-value-input';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { getPropertyPresets } from '@features/properties/public-api';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { createPropertySvgIcon } from '@features/document/properties/property-type-icon';
import { isImeKeyboardEvent } from '@/lib/input-method';
import { mountIconPickerMenu } from './frontmatter-icon-menu';
import { queryMentionTags, type MentionTagItem } from './tag-mention/tag-mention-data';
import { FrontmatterPropertyKeyPicker } from './frontmatter-property-key-picker';

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
let frontmatterTagSuggestionListId = 0;
type PropertyEditKind = PropertyKind;
const FLOWIX_COLOR_LABEL_KEYS: Record<NoteColor, I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

export function resolveRuntimePropertyPreset(key: string) {
  return resolvePropertyPreset(
    key,
    getPropertyPresets(),
  );
}

export function getPropertyEditKind(
  key: string,
  value: unknown,
  isFlowSequence = false,
  declaredTypes: unknown = {},
): PropertyEditKind {
  return resolvePropertyType(key, value, isFlowSequence, getPropertyPresets(), declaredTypes).kind;
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

export function createOptionChip(label: string, nestedLabel = false): HTMLSpanElement {
  const chip = createElement(
    'span',
    `frontmatter-property__option-chip multidimensional-table__option-chip min-w-0 max-w-full${nestedLabel ? '' : ' truncate'}`,
  );
  chip.style.setProperty('--multidimensional-table-option-hue', String(stableTextHue(label)));
  chip.title = label;
  if (nestedLabel) {
    chip.append(createElement('span', 'min-w-0 truncate', label));
  } else {
    chip.textContent = label;
  }
  return chip;
}

export function getPropertyEditValue(value: unknown, propertyKey?: string): string {
  if (value === null || value === undefined) return '';
  if (
    propertyKey === 'flowix_plugin'
    && typeof value === 'object'
    && !Array.isArray(value)
  ) {
    return JSON.stringify(value);
  }
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

export interface ActivePropertyEdit {
  property: { key: string; value: unknown };
  target: PropertyEditTarget;
  initialValue: string;
  initialKind?: PropertyEditKind;
  kind?: PropertyEditKind;
  popover: HTMLElement;
  control: PropertyEditControl;
}

interface PropertyEditorOptions {
  ownerDocument: Document;
  isEditable: () => boolean;
  getYaml: () => string;
  getDeclaredTypes: () => unknown;
  onSave: (edit: ActivePropertyEdit) => void;
}

/** Shared key/value editor for persisted properties and local drafts. */
export class FrontmatterPropertyEditor {
  activePropertyEdit: ActivePropertyEdit | null = null;
  constructor(private readonly options: PropertyEditorOptions) {}
  private t(key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) {
    return translate(getCurrentAppLanguage(), key, params);
  }
  closePropertyEditor() {
    this.activePropertyEdit?.control.destroy?.();
    this.activePropertyEdit?.popover.remove();
    this.activePropertyEdit = null;
  }
  savePropertyEdit() {
    const edit = this.activePropertyEdit;
    if (!edit) return;
    // Capture the value before destroying controls backed by React roots.
    const value = edit.control.getValue();
    const snapshot = { ...edit, control: { ...edit.control, getValue: () => value } };
    this.closePropertyEditor();
    this.options.onSave(snapshot);
  }
  open(
    property: { key: string; value: unknown },
    anchor: HTMLElement,
    target: PropertyEditTarget,
    draft?: { kind: PropertyKind; value: string },
  ) {
    if (!this.options.isEditable()) return;
    this.closePropertyEditor();

    const ownerDocument = this.options.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popover = createElement(
      'div',
      'frontmatter-property__edit-popover frontmatter-property__edit-popover--editor',
    );
    const isFlowSequence = isFrontmatterPropertyFlowSequence(
      this.options.getYaml(),
      property.key,
    );
    const initialKind = target === 'value'
      ? (draft?.kind ?? getPropertyEditKind(property.key, property.value, isFlowSequence, this.options.getDeclaredTypes()))
      : undefined;
    const initialValue = target === 'key'
      ? property.key
      : (draft?.value ?? getPropertyEditValue(property.value, property.key));

    popover.style.position = 'fixed';
    popover.style.left = `${anchorRect.left}px`;
    popover.style.top = `${anchorRect.top}px`;
    const availableWidth = Math.max(180, ownerWindow.innerWidth - anchorRect.left - 16);
    popover.style.width = `${Math.min(
      PROPERTY_EDIT_POPOVER_WIDTH,
      availableWidth,
    )}px`;
    popover.style.setProperty(
      '--frontmatter-property-key-preset-max-width',
      `${Math.max(0, ownerWindow.innerWidth - anchorRect.left - 16)}px`,
    );

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
      const triggerValue = createElement('span', 'frontmatter-property__edit-option-value');
      const chevron = createElement('span', 'frontmatter-property__edit-option-chevron');
      chevron.append(createPropertyTypeChevron());
      trigger.append(triggerValue, chevron);
      const menu = createElement('div', 'frontmatter-property__edit-option-list');
      let selectedValue = value;
      trigger.type = 'button';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-label', property.key);
      menu.setAttribute('role', 'listbox');
      menu.hidden = true;

      const renderOptions = () => {
        triggerValue.replaceChildren(selectedValue
          ? createOptionChip(selectedValue)
          : createElement('span', 'text-[var(--muted-foreground)]', this.t('document.properties.select.placeholder')));
        menu.replaceChildren();
        options.forEach((optionValue) => {
          const option = createElement('button', 'frontmatter-property__edit-option-item');
          option.type = 'button';
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', String(selectedValue === optionValue));
          option.append(createOptionChip(optionValue));
          if (selectedValue === optionValue) {
            option.append(createPropertyCheckIcon());
          }
          option.addEventListener('click', () => {
            selectedValue = optionValue;
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            trigger.dataset.state = 'closed';
            renderOptions();
            trigger.focus();
          });
          menu.append(option);
        });
      };
      trigger.addEventListener('click', () => {
        menu.hidden = !menu.hidden;
        trigger.setAttribute('aria-expanded', String(!menu.hidden));
        trigger.dataset.state = menu.hidden ? 'closed' : 'open';
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
        const checkbox = createElement('input', 'frontmatter-property__edit-checkbox flowix-hand-checkbox-input');
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

        // 图标菜单复用共享 React 面板, 挂载胶水统一收在 frontmatter-icon-menu。
        const iconMenu = mountIconPickerMenu({
          onSelect: (next: string) => {
            iconValue = next;
            renderTrigger();
            closeMenu();
            trigger.focus();
          },
        });
        iconMenu.render(iconValue);
        menu.append(iconMenu.host);

        trigger.addEventListener('click', () => {
          const open = menu.hidden;
          if (open) {
            // 每次展开都用当前值重渲染: 清除 × 之后选中高亮要跟着清掉;
            // 面板内部的包/分类浏览位置由组件 state 保留, 不受影响。
            iconMenu.render(iconValue);
          }
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
          destroy: () => iconMenu.unmount(),
        };
      }

      if (
        kind === 'Color'
      ) {
        const colorControl = createElement('div', 'frontmatter-property__edit-colors');
        colorControl.tabIndex = 0;
        colorControl.setAttribute('role', 'group');
        colorControl.setAttribute('aria-label', this.t('document.color.button'));
        const selected = new Set<NoteColor>(
          value
            .split(',')
            .map((item) => item.trim())
            .filter((item): item is NoteColor => NOTE_COLORS.includes(item as NoteColor)),
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

          NOTE_COLORS.forEach((color) => {
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
            option.style.setProperty('--frontmatter-edit-color', NOTE_COLOR_HEX[color]);
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
          getValue: () => NOTE_COLORS.filter((color) => selected.has(color)).join(', '),
          storageKind: 'Color',
        };
      }

      if (kind === 'MultiSelect') {
        const configuredOptions = resolveRuntimePropertyPreset(property.key)?.options ?? [];
        if (configuredOptions.length > 0) {
          const optionControl = createElement('div', 'frontmatter-property__edit-option-menu');
          const trigger = createElement('button', 'frontmatter-property__edit-input frontmatter-property__edit-option-trigger');
          const triggerValue = createElement('span', 'frontmatter-property__edit-option-value frontmatter-property__edit-option-value--multiple');
          const chevron = createElement('span', 'frontmatter-property__edit-option-chevron');
          chevron.append(createPropertyTypeChevron());
          trigger.append(triggerValue, chevron);
          const menu = createElement('div', 'frontmatter-property__edit-option-list');
          const selected = new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
          trigger.type = 'button';
          trigger.setAttribute('aria-haspopup', 'listbox');
          trigger.setAttribute('aria-expanded', 'false');
          trigger.setAttribute('aria-label', property.key);
          menu.setAttribute('role', 'listbox');
          menu.hidden = true;

          const renderOptions = () => {
            triggerValue.replaceChildren();
            if (selected.size > 0) {
              [...selected].forEach((optionValue) => triggerValue.append(createOptionChip(optionValue, true)));
            } else {
              triggerValue.append(createElement('span', 'text-[var(--muted-foreground)]', this.t('document.properties.select.placeholder')));
            }
            menu.replaceChildren();
            configuredOptions.forEach((optionValue) => {
              const option = createElement('button', 'frontmatter-property__edit-option-item');
              option.type = 'button';
              option.setAttribute('role', 'option');
              option.setAttribute('aria-selected', String(selected.has(optionValue)));
              option.append(createOptionChip(optionValue));
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
            trigger.dataset.state = menu.hidden ? 'closed' : 'open';
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
        if (typeof property.value !== 'boolean' && !hasConfiguredOptions) return createPlainTextControl(value, 'Select');
        if (typeof property.value !== 'boolean' && hasConfiguredOptions) {
          return createSelectControl(value);
        }
        const label = createElement('label', 'frontmatter-property__edit-checkbox-label');
        const checkbox = createElement('input', 'frontmatter-property__edit-checkbox flowix-hand-checkbox-input');
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

      if (kind === 'MultiSelect' || kind === 'Tag') {
        const tagControl = createElement('div', 'frontmatter-property__edit-tags');
        const chips = createElement('div', 'frontmatter-property__edit-tags-chips');
        const input = createElement(
          'input',
          'frontmatter-property__edit-input frontmatter-property__edit-tags-input',
        );
        const isNoteTags = canonicalizePropertyKey(property.key) === 'tags';
        const suggestions = createElement('div', 'frontmatter-property__edit-tag-suggestions');
        suggestions.hidden = true;
        const suggestionListId = `frontmatter-tag-suggestions-${++frontmatterTagSuggestionListId}`;
        const normalizeInput = (item: string) => (
          isNoteTags ? normalizeTagInput(item) : item.trim()
        );
        let tags = value.split(',').map(normalizeInput).filter(Boolean);
        let activeTagIndex: number | null = null;
        let mentionSuggestions: MentionTagItem[] = [];
        let activeSuggestion = 0;
        let suggestionRequest = 0;

        const renderSuggestions = () => {
          suggestions.replaceChildren();
          suggestions.hidden = !isNoteTags || mentionSuggestions.length === 0;
          input.setAttribute('aria-expanded', String(!suggestions.hidden));
          if (suggestions.hidden) {
            input.removeAttribute('aria-controls');
            input.removeAttribute('aria-activedescendant');
            return;
          }
          input.setAttribute('aria-controls', suggestionListId);
          suggestions.id = suggestionListId;
          mentionSuggestions.forEach((suggestion, index) => {
            const option = createElement('button', 'frontmatter-property__edit-tag-suggestion');
            option.type = 'button';
            option.tabIndex = -1;
            option.id = `${suggestionListId}-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === activeSuggestion));
            if (index === activeSuggestion) {
              option.dataset.active = 'true';
              input.setAttribute('aria-activedescendant', option.id);
            }
            option.append(
              createElement('span', 'flowix-tag-icon flowix-tag-icon--prefix', '#'),
              createElement('span', 'tag-node-content', suggestion.name),
            );
            option.addEventListener('mousedown', (event) => event.preventDefault());
            option.addEventListener('mouseenter', () => {
              activeSuggestion = index;
              suggestions.querySelectorAll<HTMLElement>('[role="option"]').forEach((item, itemIndex) => {
                item.setAttribute('aria-selected', String(itemIndex === activeSuggestion));
                item.toggleAttribute('data-active', itemIndex === activeSuggestion);
              });
              input.setAttribute('aria-activedescendant', option.id);
            });
            option.addEventListener('click', () => selectSuggestion(suggestion.name));
            suggestions.append(option);
          });
          suggestions.querySelector<HTMLElement>(`#${suggestionListId}-${activeSuggestion}`)
            ?.scrollIntoView?.({ block: 'nearest' });
        };

        const updateSuggestions = () => {
          const request = ++suggestionRequest;
          const query = input.value;
          if (!isNoteTags || locallyComposing || !query.trim().replace(/^#+/, '').trim()) {
            mentionSuggestions = [];
            activeSuggestion = 0;
            renderSuggestions();
            return;
          }
          mentionSuggestions = [];
          activeSuggestion = 0;
          renderSuggestions();
          void queryMentionTags(query).then((items) => {
            if (request !== suggestionRequest || locallyComposing) return;
            mentionSuggestions = items.filter(
              (item) => !item.create && !tags.includes(normalizeTagInput(item.name)),
            );
            activeSuggestion = 0;
            renderSuggestions();
          });
        };

        const selectSuggestion = (name: string) => {
          const tag = normalizeTagInput(name);
          if (tag && !tags.includes(tag)) tags = [...tags, tag];
          input.value = '';
          activeTagIndex = null;
          activeSuggestion = 0;
          renderTags();
          updateSuggestions();
          input.focus();
        };

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
              chip.append(createElement('span', 'tag-node-content', tag));
            }
            chips.append(chip);
          });
        };

        input.type = 'text';
        input.spellcheck = false;
        input.setAttribute('aria-label', this.t('document.properties.tagInputPlaceholder'));
        input.setAttribute('data-property-key', property.key);
        if (isNoteTags) {
          input.setAttribute('role', 'combobox');
          input.setAttribute('aria-autocomplete', 'list');
          input.setAttribute('aria-haspopup', 'listbox');
          suggestions.setAttribute('role', 'listbox');
          suggestions.setAttribute('aria-label', this.t('document.properties.tagInputPlaceholder'));
        }
        input.addEventListener('compositionstart', () => {
          locallyComposing = true;
          suggestionRequest += 1;
          mentionSuggestions = [];
          activeSuggestion = 0;
          renderSuggestions();
        });
        input.addEventListener('compositionend', () => {
          locallyComposing = false;
          renderTags();
          updateSuggestions();
        });
        input.addEventListener('input', () => {
          activeTagIndex = null;
          renderTags();
          if (!locallyComposing) updateSuggestions();
        });
        input.addEventListener('keydown', (event) => {
          if (isImeKeyboardEvent(event, locallyComposing)) return;
          if (mentionSuggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            activeSuggestion = (activeSuggestion + (event.key === 'ArrowDown' ? 1 : -1) + mentionSuggestions.length) % mentionSuggestions.length;
            renderSuggestions();
            return;
          }
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && mentionSuggestions[activeSuggestion]) {
            event.preventDefault();
            selectSuggestion(mentionSuggestions[activeSuggestion].name);
            return;
          }
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
            updateSuggestions();
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
          updateSuggestions();
        });
        renderTags();
        tagControl.append(chips, input);
        if (isNoteTags) tagControl.append(suggestions);
        return {
          dom: tagControl,
          focusTarget: input,
          getValue: () => [...tags, normalizeInput(input.value)].filter(Boolean).join(', '),
          storageKind: kind,
          destroy: () => { suggestionRequest += 1; },
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
      const keyControl = createElement('div', 'frontmatter-property__edit-key-control');
      const presets = getAllPresets(getPropertyPresets(), (labelKey) => this.t(labelKey));
      const pickerHost = createElement('div', 'frontmatter-property__edit-key-preset-host');
      const pickerRoot = createRoot(pickerHost);
      const setKey = (nextKey: string) => {
        input.value = nextKey;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const renderPicker = (key: string) => {
        pickerRoot.render(createReactElement(FrontmatterPropertyKeyPicker, {
          presets,
          propertyKey: key,
          t: (labelKey: I18nKey) => this.t(labelKey),
          onSelect: (preset) => {
            setKey(preset.key);
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          },
        }));
      };
      renderPicker(initialValue);
      input.addEventListener('input', () => {
        renderPicker(input.value);
      });
      keyControl.append(pickerHost, input);
      control = {
        dom: keyControl,
        focusTarget: input,
        getValue: () => input.value,
        storageKind: 'Text',
        destroy: () => pickerRoot.unmount(),
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
        getPropertyPresets(),
      );
      const isFixedPropertyKind = target === 'value' && propertyPreset !== null;
      typeTrigger.type = 'button';
      typeTrigger.disabled = isFixedPropertyKind;
      typeTrigger.setAttribute('aria-haspopup', 'listbox');
      typeTrigger.setAttribute('aria-expanded', 'false');
      typeTrigger.setAttribute('aria-disabled', String(isFixedPropertyKind));
      typeTrigger.setAttribute('aria-label', this.t('document.properties.typeColumn'));
      const typeLabel = createElement(
        'span',
        'frontmatter-property__edit-type-label',
        this.t(getPropertyTypeDefinition(initialKind ?? 'Text').labelKey),
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
      const closeTypeMenu = () => {
        typeMenu.hidden = true;
        typeTrigger.setAttribute('aria-expanded', 'false');
      };
      control.focusTarget.addEventListener('focus', closeTypeMenu);
      PROPERTY_EDIT_KINDS.forEach((kind) => {
        const option = createElement(
          'button',
          'frontmatter-property__edit-type-option',
        );
        option.type = 'button';
        option.dataset.value = kind;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(kind === initialKind));
        const typeIcon = createElement('span', 'frontmatter-property__edit-type-option-icon');
        typeIcon.append(createPropertySvgIcon(getPropertyTypeDefinition(kind).iconKind));
        const typeOptionLabel = createElement(
          'span',
          'frontmatter-property__edit-type-option-label',
          this.t(getPropertyTypeDefinition(kind).labelKey),
        );
        option.append(typeIcon, typeOptionLabel);
        option.addEventListener('click', () => {
          const activeEdit = this.activePropertyEdit;
          if (activeEdit?.popover !== popover || activeEdit.target !== 'value') return;
          const nextValue = activeEdit.control.getValue();
          const nextControl = createControl(kind, nextValue);
          activeEdit.kind = kind;
          activeEdit.control.destroy?.();
          activeEdit.control.dom.replaceWith(nextControl.dom);
          activeEdit.control = nextControl;
          typeLabel.textContent = this.t(getPropertyTypeDefinition(kind).labelKey);
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

}
