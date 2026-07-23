import YAML from 'yaml';
import type { I18nKey } from '@features/i18n';
import {
  PROPERTY_ICON_OPTIONS,
  getPropertyIconOption,
} from '@features/document/properties/property-icons';
import type { PropertyKind } from '@features/document/properties/presets';

type Translate = (key: I18nKey) => string;

interface ValueDisplayOptions {
  value: unknown;
  text: string;
  kind?: PropertyKind;
  t: Translate;
}

interface ValueControlOptions {
  value: string;
  kind?: PropertyKind;
  options?: readonly string[];
  t: Translate;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

export interface FrontmatterValueControl {
  dom: HTMLElement;
  focus: () => void;
}

const OPTION_LABEL_KEYS: Partial<Record<string, I18nKey>> = {
  note: 'document.properties.option.note',
  prompt: 'document.properties.option.prompt',
  todo: 'document.properties.option.todo',
  'in-progress': 'document.properties.option.inProgress',
  done: 'document.properties.option.done',
};

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

function formatOptionLabel(option: string, t: Translate): string {
  const key = OPTION_LABEL_KEYS[option];
  return key ? t(key) : option;
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

function toTags(value: string): string[] {
  if (!value.trim()) return [];
  try {
    const parsed = YAML.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Friendly comma-separated input remains supported.
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function inferFrontmatterPropertyKind(
  value: unknown,
  configuredKind?: PropertyKind,
): PropertyKind | undefined {
  if (configuredKind) return configuredKind;
  if (Array.isArray(value)) return 'MultiSelect';
  if (typeof value === 'number') return 'Number';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Date';
    if (/^https?:\/\/\S+$/i.test(value)) return 'URL';
  }
  return undefined;
}

export function createFrontmatterValueDisplay({
  value,
  text,
  kind,
  t,
}: ValueDisplayOptions): HTMLElement {
  const container = createElement('span', 'frontmatter-property__value');

  if (kind === 'Icon') {
    const selected = getPropertyIconOption(String(value ?? ''));
    if (selected) {
      const image = createElement('img', 'frontmatter-property__value-icon');
      image.src = selected.src;
      image.alt = '';
      image.draggable = false;
      image.title = selected.label;
      container.append(image);
      return container;
    }
  }

  if (kind === 'MultiSelect') {
    const values = Array.isArray(value) ? value.map(String) : toTags(String(value ?? ''));
    const chips = createElement('span', 'frontmatter-property__value-chips');
    values.forEach((item) => {
      const chip = createElement('span', 'frontmatter-property__value-chip', item);
      chip.title = item;
      chips.append(chip);
    });
    container.append(chips);
    return container;
  }

  const displayText = kind === 'Select' ? formatOptionLabel(text, t) : text;
  const label = createElement('span', 'frontmatter-property__value-text', displayText);
  if (kind === 'URL') label.classList.add('frontmatter-property__value-text--url');
  container.append(label);
  return container;
}

function createTextControl({
  value,
  kind,
  onChange,
  onKeyDown,
}: ValueControlOptions): FrontmatterValueControl {
  const input = createElement(
    'input',
    'frontmatter-property__input frontmatter-property__value-input frontmatter-property__value-focus',
  );
  input.type = kind === 'Number' ? 'number' : kind === 'URL' ? 'url' : 'text';
  input.value = value;
  input.spellcheck = false;
  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('keydown', onKeyDown);
  return { dom: input, focus: () => input.focus() };
}

function createDateControl({
  value,
  onChange,
  onKeyDown,
}: ValueControlOptions): FrontmatterValueControl {
  const input = createElement(
    'input',
    'frontmatter-property__input frontmatter-property__value-input frontmatter-property__value-focus frontmatter-property__date-input',
  );
  input.type = 'date';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('change', () => onChange(input.value));
  input.addEventListener('keydown', onKeyDown);
  return { dom: input, focus: () => input.focus() };
}

function createSelectControl(config: ValueControlOptions): FrontmatterValueControl {
  const choices = [...new Set([
    ...(config.options ?? []),
    ...(config.value && !(config.options ?? []).includes(config.value) ? [config.value] : []),
  ])];
  if (choices.length === 0) return createTextControl(config);

  const picker = createElement('div', 'frontmatter-property__value-picker');
  const trigger = createElement(
    'button',
    'frontmatter-property__value-trigger frontmatter-property__value-focus',
  );
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const triggerLabel = createElement(
    'span',
    'frontmatter-property__value-trigger-label',
    config.value ? formatOptionLabel(config.value, config.t) : config.t('document.properties.select.placeholder'),
  );
  trigger.append(
    triggerLabel,
    createElement('span', 'frontmatter-property__value-trigger-icon'),
  );

  const menu = createElement('div', 'frontmatter-property__value-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  choices.forEach((choice) => {
    const selected = choice === config.value;
    const option = createElement('button', 'frontmatter-property__value-option');
    option.type = 'button';
    option.dataset.value = choice;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(selected));
    option.append(
      createElement('span', 'frontmatter-property__value-option-label', formatOptionLabel(choice, config.t)),
      createElement('span', 'frontmatter-property__value-option-check'),
    );
    if (selected) {
      option.querySelector('.frontmatter-property__value-option-check')?.append(createCheckIcon());
    }
    option.addEventListener('click', () => {
      config.onChange(choice);
      triggerLabel.textContent = formatOptionLabel(choice, config.t);
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    });
    menu.append(option);
  });

  trigger.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
      return;
    }
    config.onKeyDown(event);
  });
  picker.append(trigger, menu);
  return { dom: picker, focus: () => trigger.focus() };
}

function createIconControl(config: ValueControlOptions): FrontmatterValueControl {
  const picker = createElement('div', 'frontmatter-property__value-picker');
  const trigger = createElement(
    'button',
    'frontmatter-property__value-trigger frontmatter-property__value-focus frontmatter-property__icon-trigger',
  );
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');

  const renderTrigger = (value: string) => {
    trigger.replaceChildren();
    const selected = getPropertyIconOption(value);
    if (selected) {
      const image = createElement('img', 'frontmatter-property__value-icon');
      image.src = selected.src;
      image.alt = '';
      image.draggable = false;
      trigger.title = selected.label;
      trigger.append(image);
    } else {
      trigger.title = config.t('document.properties.select.placeholder');
      trigger.append(createElement('span', 'frontmatter-property__icon-placeholder'));
    }
    trigger.append(createElement('span', 'frontmatter-property__value-trigger-icon'));
  };
  renderTrigger(config.value);

  const menu = createElement(
    'div',
    'frontmatter-property__value-menu frontmatter-property__value-menu--icons',
  );
  menu.hidden = true;
  const grid = createElement('div', 'frontmatter-property__icon-grid');
  PROPERTY_ICON_OPTIONS.forEach((choice) => {
    const option = createElement('button', 'frontmatter-property__icon-option');
    option.type = 'button';
    option.dataset.value = choice.value;
    option.title = choice.label;
    option.setAttribute('aria-label', choice.label);
    option.setAttribute('aria-selected', String(choice.value === config.value));
    const image = createElement('img', '');
    image.src = choice.src;
    image.alt = '';
    image.draggable = false;
    option.append(image);
    option.addEventListener('click', () => {
      config.onChange(choice.value);
      renderTrigger(choice.value);
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    });
    grid.append(option);
  });
  menu.append(grid);
  trigger.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
      return;
    }
    config.onKeyDown(event);
  });
  picker.append(trigger, menu);
  return { dom: picker, focus: () => trigger.focus() };
}

function createMultiSelectControl(config: ValueControlOptions): FrontmatterValueControl {
  let tags = toTags(config.value);
  const picker = createElement(
    'div',
    'frontmatter-property__value-picker frontmatter-property__multi-picker',
  );
  const control = createElement('div', 'frontmatter-property__multi-control');
  const chips = createElement('span', 'frontmatter-property__multi-chips');
  const input = createElement(
    'input',
    'frontmatter-property__multi-input frontmatter-property__value-focus',
  );
  input.type = 'text';
  input.spellcheck = false;
  const menu = createElement('div', 'frontmatter-property__value-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');

  const add = (value: string) => {
    const next = value.trim().replace(/,$/, '').trim();
    if (next && !tags.includes(next)) tags = [...tags, next];
    input.value = '';
    config.onChange(tags.join(', '));
    render();
    renderSuggestions();
  };
  const commit = () => {
    add(input.value);
    menu.hidden = true;
  };
  const remove = (tag: string) => {
    tags = tags.filter((item) => item !== tag);
    config.onChange(tags.join(', '));
    render();
    renderSuggestions();
    input.focus();
  };
  const render = () => {
    chips.replaceChildren();
    tags.forEach((tag) => {
      const chip = createElement('span', 'frontmatter-property__multi-chip');
      chip.append(
        createElement('span', 'frontmatter-property__multi-chip-label', tag),
      );
      const removeButton = createElement('button', 'frontmatter-property__multi-remove', '×');
      removeButton.type = 'button';
      removeButton.tabIndex = -1;
      removeButton.addEventListener('click', () => remove(tag));
      chip.append(removeButton);
      chips.append(chip);
    });
  };
  const renderSuggestions = () => {
    menu.replaceChildren();
    const query = input.value.trim().toLocaleLowerCase();
    const choices = [...new Set(config.options ?? [])]
      .filter((choice) => !tags.includes(choice))
      .filter((choice) => !query || choice.toLocaleLowerCase().includes(query));
    choices.forEach((choice) => {
      const option = createElement('button', 'frontmatter-property__value-option');
      option.type = 'button';
      option.dataset.value = choice;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.append(
        createElement('span', 'frontmatter-property__value-option-label', choice),
        createElement('span', 'frontmatter-property__value-option-check'),
      );
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => {
        add(choice);
        input.focus();
      });
      menu.append(option);
    });
    menu.hidden = choices.length === 0;
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      menu.hidden = true;
      return;
    }
    if (event.key === 'Backspace' && !input.value && tags.length > 0) {
      remove(tags[tags.length - 1]);
      return;
    }
    config.onKeyDown(event);
  });
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('input', renderSuggestions);
  input.addEventListener('blur', commit);
  render();
  control.append(chips, input);
  picker.append(control, menu);
  return { dom: picker, focus: () => input.focus() };
}

export function createFrontmatterValueControl(
  config: ValueControlOptions,
): FrontmatterValueControl {
  switch (config.kind) {
    case 'Date':
      return createDateControl(config);
    case 'Icon':
      return createIconControl(config);
    case 'Select':
      return createSelectControl(config);
    case 'MultiSelect':
      return createMultiSelectControl(config);
    case 'Number':
    case 'URL':
    case 'Text':
    default:
      return createTextControl(config);
  }
}
