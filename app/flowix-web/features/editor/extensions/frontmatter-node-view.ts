import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { translate } from '@features/i18n';
import {
  FrontmatterPropertyError,
  formatFrontmatterPropertyValue,
  parseVisibleFrontmatter,
  toFrontmatterPropertyInput,
  updateVisibleFrontmatterProperty,
} from '@features/document/properties/frontmatter-model';
import { PRESETS, resolvePreset, type PropertyKind } from '@features/document/properties/presets';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { useTagStore } from '@features/memo/store/tag-store';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import {
  createFrontmatterValueControl,
  createFrontmatterValueDisplay,
  inferFrontmatterPropertyKind,
} from './frontmatter-inline-value';

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

function createCheckIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M20 6 9 17l-5-5');
  svg.append(path);
  return svg;
}

export class FrontmatterPropertyNodeView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProseMirrorNode;
  private isEditing = false;
  private editingPreviousKey: string | null = null;
  private editKey = '';
  private editValue = '';
  private isAddingTag = false;
  private tagDraft = '';
  private validationError: string | null = null;
  private readonly unsubscribeSettings: () => void;
  private readonly handleDocumentPointerDown = (event: Event) => {
    if (!this.isEditing && !this.isAddingTag) return;
    const target = event.target;
    if (!(target instanceof globalThis.Node) || this.dom.contains(target)) return;
    if (this.isAddingTag) {
      this.saveTagAddition();
    } else {
      this.saveProperty();
    }
  };

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom = createElement('div', 'frontmatter-property-node');
    this.dom.contentEditable = 'false';
    this.unsubscribeSettings = useUserSettingsStore.subscribe((state, previous) => {
      if (
        state.settings.language !== previous.settings.language
        || state.settings.properties.fields !== previous.settings.properties.fields
      ) {
        this.render();
      }
    });
    this.dom.ownerDocument.addEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    );
    this.render();
  }

  private t(key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) {
    return translate(useUserSettingsStore.getState().settings.language, key, params);
  }

  private propertyPresentation(key: string): {
    label: string;
    kind?: PropertyKind;
    options?: readonly string[];
  } {
    const preset = resolvePreset(key);
    if (preset) {
      return {
        label: this.t(preset.labelKey),
        kind: preset.kind,
        options: preset.options,
      };
    }

    const custom = useUserSettingsStore
      .getState()
      .settings.properties.fields.find((field) => field.key === key);
    return {
      label: custom?.name?.trim() || key,
      kind: custom?.type,
      options: custom?.options,
    };
  }

  private activateEditingTarget(target: 'key' | 'value') {
    if (target === 'key') {
      const trigger = this.dom.querySelector<HTMLButtonElement>(
        '.frontmatter-property__key-trigger',
      );
      trigger?.focus();
      trigger?.click();
      return;
    }

    const control = this.dom.querySelector<HTMLElement>(
      '.frontmatter-property__value-focus',
    );
    control?.focus();
    if (control instanceof HTMLButtonElement) {
      control.click();
    } else if (control instanceof HTMLInputElement) {
      control.select();
      if (control.type === 'date' && typeof control.showPicker === 'function') {
        try {
          control.showPicker();
        } catch {
          // Some browser contexts only allow showPicker during a trusted event.
        }
      }
    }
  }

  private beginEditing(
    property: { key: string; value: unknown } | null,
    target: 'key' | 'value' = 'key',
  ) {
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    if (parsed.parseError) return;
    this.validationError = null;
    this.editingPreviousKey = property?.key ?? null;
    this.editKey = property ? canonicalizePropertyKey(property.key) : '';
    this.editValue = property ? toFrontmatterPropertyInput(property.value) : '';
    this.isEditing = true;
    this.render();
    this.activateEditingTarget(target);
  }

  private cancelEditing() {
    this.isEditing = false;
    this.editingPreviousKey = null;
    this.validationError = null;
    this.render();
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
        return this.t('document.properties.picker.reservedKeyError', { key: 'key' });
      case 'invalid-tag':
        return this.t('document.properties.invalidTag');
      default:
        return error.message;
    }
  }

  private saveProperty() {
    if (this.editingPreviousKey === null && !this.editKey.trim()) {
      this.cancelEditing();
      return;
    }

    const yamlContent = String(this.node.attrs.yamlContent ?? '');
    const kind = this.propertyPresentation(this.editKey.trim()).kind;
    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        yamlContent,
        this.editingPreviousKey,
        this.editKey,
        this.editValue,
        kind,
      );
      const pos = this.getPos();
      if (typeof pos !== 'number') return;
      this.isEditing = false;
      this.editingPreviousKey = null;
      this.validationError = null;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          yamlContent: nextYamlContent,
        }),
      );
      // ProseMirror only re-runs `update()` (which renders) when the doc
      // actually changes. A no-op commit -- reopening an existing property
      // and dismissing without edits -- leaves the editor DOM mounted even
      // though `isEditing` is now false. Render explicitly so the editor row
      // is always torn down on save.
      this.render();
    } catch (error) {
      this.validationError = this.errorMessage(error);
      this.render();
    }
  }

  private handleEditorKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEditing();
    } else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      this.saveProperty();
    }
  };

  private updateTags(tags: string[], previousKey: string | null) {
    const yamlContent = String(this.node.attrs.yamlContent ?? '');
    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        yamlContent,
        previousKey,
        'tags',
        tags.join(', '),
        'MultiSelect',
      );
      const pos = this.getPos();
      if (typeof pos !== 'number') return;
      this.isAddingTag = false;
      this.tagDraft = '';
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

  private saveTagAddition() {
    if (!this.isAddingTag) return;
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const property = parsed.properties.find(
      (item) => canonicalizePropertyKey(item.key) === 'tags',
    );
    const currentTags = Array.isArray(property?.value)
      ? property.value.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const nextTag = this.tagDraft.trim();
    if (!nextTag || currentTags.includes(nextTag)) {
      this.isAddingTag = false;
      this.tagDraft = '';
      this.validationError = null;
      this.render();
      return;
    }
    this.updateTags([...currentTags, nextTag], property?.key ?? null);
  }

  private renderTags(container: HTMLElement, property?: { key: string; value: unknown }) {
    const tags = Array.isArray(property?.value)
      ? property.value.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const tagArea = createElement('div', 'frontmatter-property__tags');

    tags.forEach((tag) => {
      const chip = createElement('span', 'frontmatter-property__tag-chip');
      chip.title = tag;
      chip.append(createElement('span', 'frontmatter-property__tag-label', tag));
      const remove = createElement('button', 'frontmatter-property__tag-remove', '×');
      remove.type = 'button';
      remove.setAttribute(
        'aria-label',
        this.t('document.properties.deleteTag', { tag }),
      );
      remove.addEventListener('click', () => {
        this.updateTags(tags.filter((item) => item !== tag), property?.key ?? null);
      });
      chip.append(remove);
      tagArea.append(chip);
    });

    if (this.isAddingTag) {
      const input = createElement('input', 'frontmatter-property__tag-input');
      input.type = 'text';
      input.value = this.tagDraft;
      input.placeholder = this.t('document.properties.tagInputPlaceholder');
      input.setAttribute('aria-label', this.t('document.properties.tagInputPlaceholder'));
      input.addEventListener('input', () => {
        this.tagDraft = input.value;
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          this.isAddingTag = false;
          this.tagDraft = '';
          this.validationError = null;
          this.render();
        } else if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          this.saveTagAddition();
        }
      });
      input.addEventListener('blur', () => {
        queueMicrotask(() => this.saveTagAddition());
      });
      tagArea.append(input);
      queueMicrotask(() => input.focus());
    } else {
      const addLabel = this.t('document.properties.addTag');
      const add = createElement('button', 'frontmatter-property__tag-add', addLabel);
      add.type = 'button';
      add.title = addLabel;
      add.setAttribute('aria-label', addLabel);
      add.addEventListener('click', () => {
        this.isAddingTag = true;
        this.tagDraft = '';
        this.validationError = null;
        this.render();
      });
      tagArea.append(add);
    }

    const addProperty = createElement(
      'button',
      'frontmatter-property__add-property',
    );
    addProperty.type = 'button';
    addProperty.addEventListener('click', () => {
      if (this.isEditing && this.editingPreviousKey === null) {
        this.activateEditingTarget('key');
        return;
      }
      this.beginEditing(null);
    });
    addProperty.append(
      createElement('span', '', this.t('document.properties.addField')),
    );
    tagArea.append(addProperty);

    container.append(tagArea);
  }

  private renderEditor(container: HTMLElement) {
    const editor = createElement('div', 'frontmatter-property__editor');
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const usedKeys = new Set(parsed.properties.map((property) => property.key));
    const configuredFields = useUserSettingsStore.getState().settings.properties.fields;
    const presetKeys = new Set(PRESETS.map((preset) => preset.key));
    const keyChoices = [
      ...PRESETS.map((preset) => ({
        key: preset.key,
        label: this.t(preset.labelKey),
      })),
      ...configuredFields
        .filter((field) => !presetKeys.has(field.key))
        .map((field) => ({
          key: field.key,
          label: field.name.trim() || field.key,
        })),
    ];
    if (
      this.editKey
      && !presetKeys.has(this.editKey)
      && !configuredFields.some((field) => field.key === this.editKey)
    ) {
      keyChoices.push({ key: this.editKey, label: this.editKey });
    }

    const editedProperty = parsed.properties.find(
      (property) => property.key === this.editingPreviousKey,
    );
    const valuePresentation = this.propertyPresentation(this.editKey);
    const valueKind = inferFrontmatterPropertyKind(
      editedProperty?.value,
      valuePresentation.kind,
    );
    const valueControl = createFrontmatterValueControl({
      value: this.editValue,
      kind: valueKind,
      options: this.editKey === 'tags'
        ? useTagStore.getState().tags.map((tag) => tag.name)
        : valuePresentation.options,
      t: (key) => this.t(key),
      onChange: (value) => {
        this.editValue = value;
      },
      onKeyDown: this.handleEditorKeyDown,
    });

    const keyPicker = createElement('div', 'frontmatter-property__key-picker');
    const keyTrigger = createElement('button', 'frontmatter-property__key-trigger');
    keyTrigger.type = 'button';
    keyTrigger.setAttribute('aria-haspopup', 'listbox');
    keyTrigger.setAttribute('aria-expanded', 'false');
    keyTrigger.setAttribute('aria-label', this.t('document.properties.fieldColumn'));
    const keyTriggerLabel = createElement(
      'span',
      'frontmatter-property__key-trigger-label',
      this.editKey
        ? this.propertyPresentation(this.editKey).label
        : this.t('document.properties.keyPlaceholder'),
    );
    const keyTriggerIcon = createElement('span', 'frontmatter-property__key-trigger-icon');
    keyTriggerIcon.setAttribute('aria-hidden', 'true');
    keyTrigger.append(keyTriggerLabel, keyTriggerIcon);

    const keyMenu = createElement('div', 'frontmatter-property__key-menu');
    keyMenu.setAttribute('role', 'listbox');
    keyMenu.hidden = true;
    keyChoices.forEach((choice) => {
      const item = createElement('button', 'frontmatter-property__key-option');
      item.type = 'button';
      item.setAttribute('role', 'option');
      const selected = choice.key === this.editKey;
      const disabled = usedKeys.has(choice.key) && choice.key !== this.editingPreviousKey;
      item.disabled = disabled;
      item.dataset.key = choice.key;
      item.setAttribute('aria-selected', String(selected));
      item.title = `${choice.label} · ${choice.key}`;
      const text = createElement('span', 'frontmatter-property__key-option-text');
      text.append(
        createElement('span', 'frontmatter-property__key-option-label', choice.label),
        createElement('span', 'frontmatter-property__key-option-code', choice.key),
      );
      const check = createElement('span', 'frontmatter-property__key-option-check');
      if (disabled) {
        check.append(createElement(
          'span',
          'frontmatter-property__key-option-added',
          this.t('document.properties.picker.added'),
        ));
      } else if (selected) {
        check.append(createCheckIcon());
      }
      item.append(text, check);
      item.addEventListener('click', () => {
        this.editKey = choice.key;
        this.render();
        this.dom.querySelector<HTMLElement>('.frontmatter-property__value-focus')?.focus();
      });
      keyMenu.append(item);
    });
    keyTrigger.addEventListener('click', () => {
      const nextOpen = keyMenu.hidden;
      keyMenu.hidden = !nextOpen;
      keyTrigger.setAttribute('aria-expanded', String(nextOpen));
      if (nextOpen) {
        keyMenu.querySelector<HTMLButtonElement>(
          '.frontmatter-property__key-option:not(:disabled)',
        )?.focus();
      }
    });
    keyTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!keyMenu.hidden) {
          keyMenu.hidden = true;
          keyTrigger.setAttribute('aria-expanded', 'false');
          keyTrigger.focus();
        } else {
          this.cancelEditing();
        }
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        keyMenu.hidden = false;
        keyTrigger.setAttribute('aria-expanded', 'true');
        keyMenu.querySelector<HTMLButtonElement>(
          '.frontmatter-property__key-option:not(:disabled)',
        )?.focus();
      }
    });
    keyMenu.addEventListener('keydown', (event) => {
      const options = [...keyMenu.querySelectorAll<HTMLButtonElement>(
        '.frontmatter-property__key-option:not(:disabled)',
      )];
      const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        keyMenu.hidden = true;
        keyTrigger.setAttribute('aria-expanded', 'false');
        keyTrigger.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + direction + options.length) % options.length;
        options[nextIndex]?.focus();
      }
    });
    keyPicker.append(keyTrigger, keyMenu);

    editor.append(
      keyPicker,
      valueControl.dom,
    );
    editor.addEventListener('focusout', (event) => {
      const nextTarget = event.relatedTarget;
      // Focus is clearly staying inside the node -> nothing to commit.
      if (nextTarget instanceof globalThis.Node && this.dom.contains(nextTarget)) return;
      // Otherwise defer: picking a key re-renders and evicts the focused key
      // option, and WebKit fires `focusout` on the detached previous editor
      // with `relatedTarget` of null OR document.body (focus briefly lands on
      // body before the new value control is focused). Acting synchronously
      // would misread that as "focus left the editor" and prematurely commit /
      // cancel the property. Wait for the focus chain to settle, then check
      // where focus actually landed against the persistent node container.
      queueMicrotask(() => {
        if (
          this.isEditing
          && !this.dom.contains(document.activeElement)
        ) {
          this.saveProperty();
        }
      });
    });
    if (this.validationError) {
      const validation = createElement(
        'span',
        'frontmatter-property__validation',
        this.validationError,
      );
      validation.title = this.validationError;
      editor.append(validation);
    }
    container.append(editor);
  }

  private render() {
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const container = createElement('div', 'frontmatter-property');

    if (parsed.parseError) {
      const error = createElement(
        'div',
        'frontmatter-property__error',
        this.t('document.properties.yamlParseError'),
      );
      error.title = parsed.parseError;
      container.append(error);
    } else {
      const list = createElement('div', 'frontmatter-property__list');
      const tagsProperty = parsed.properties.find(
        (property) => canonicalizePropertyKey(property.key) === 'tags',
      );
      this.renderTags(list, tagsProperty);
      const regularProperties = parsed.properties.filter(
        (property) => canonicalizePropertyKey(property.key) !== 'tags',
      );

      if (this.isEditing && this.editingPreviousKey === null) {
        this.renderEditor(list);
      }

      regularProperties.forEach((property) => {
        if (this.isEditing && this.editingPreviousKey === property.key) {
          this.renderEditor(list);
          return;
        }

        const presentation = this.propertyPresentation(property.key);
        const kind = inferFrontmatterPropertyKind(property.value, presentation.kind);
        const row = createElement('div', 'frontmatter-property__display');
        row.dataset.key = property.key;

        const keyButton = createElement('button', 'frontmatter-property__display-key');
        keyButton.type = 'button';
        keyButton.title = property.key;
        keyButton.addEventListener('click', () => this.beginEditing(property, 'key'));
        keyButton.append(
          createElement('span', 'frontmatter-property__key', presentation.label),
        );

        const valueButton = createElement('button', 'frontmatter-property__display-value');
        valueButton.type = 'button';
        valueButton.title = formatFrontmatterPropertyValue(property.value, 240);
        valueButton.addEventListener('click', () => this.beginEditing(property, 'value'));
        valueButton.append(
          createFrontmatterValueDisplay({
            value: property.value,
            text: formatFrontmatterPropertyValue(property.value),
            kind,
            t: (key) => this.t(key),
          }),
        );
        row.append(keyButton, valueButton);
        list.append(row);
      });
      container.append(list);
    }

    this.dom.replaceChildren(container);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const yamlChanged = node.attrs.yamlContent !== this.node.attrs.yamlContent;
    this.node = node;
    if (yamlChanged && this.isEditing) {
      this.isEditing = false;
      this.editingPreviousKey = null;
      this.validationError = null;
    }
    if (yamlChanged && this.isAddingTag) {
      this.isAddingTag = false;
      this.tagDraft = '';
      this.validationError = null;
    }
    if (!this.isEditing || yamlChanged) this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.dom.contains(event.target as globalThis.Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.dom.ownerDocument.removeEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    );
    this.unsubscribeSettings();
  }
}
