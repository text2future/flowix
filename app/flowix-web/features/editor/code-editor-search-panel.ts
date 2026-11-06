import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

export interface CodeEditorSearchPanelLabels {
  search: string;
  replace: string;
  replaceWith: string;
  replaceAll: string;
  previous: string;
  next: string;
  close: string;
  toggleReplace: string;
  moreSettings: string;
  matchCase: string;
  regularExpression: string;
  wholeWord: string;
  selectAllMatches: string;
}

type SearchPanelButton = HTMLButtonElement & { iconName: string };

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const paths: Record<string, string[]> = {
    chevronRight: ['m9 18 6-6-6-6'],
    chevronDown: ['m6 9 6 6 6-6'],
    up: ['m18 15-6-6-6 6'],
    down: ['m6 9 6 6 6-6'],
    close: ['M18 6 6 18', 'm6 6 12 12'],
    settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M2 14h4', 'M10 8h4', 'M18 16h4'],
    replace: ['M16 3l4 4-4 4', 'M20 7H4', 'm8 21-4-4 4-4', 'M4 17h16'],
    replaceAll: ['M7 7h14', 'M7 12h14', 'M7 17h14', 'M3 7h.01', 'M3 12h.01', 'M3 17h.01'],
    selectAll: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  };

  for (const d of paths[name] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  svg.classList.add('cm-code-search-icon');
  return svg;
}

function makeButton(
  label: string,
  iconName: string,
  onClick: () => void,
  className = '',
): SearchPanelButton {
  const button = document.createElement('button') as SearchPanelButton;
  button.type = 'button';
  button.className = `cm-code-search-icon-button ${className}`.trim();
  button.title = label;
  button.setAttribute('aria-label', label);
  button.iconName = iconName;
  button.append(icon(iconName));
  button.addEventListener('click', onClick);
  return button;
}

function makeOption(label: string, name: string): { row: HTMLLabelElement; input: HTMLInputElement; text: HTMLSpanElement } {
  const row = document.createElement('label');
  row.className = 'cm-code-search-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  const text = document.createElement('span');
  text.textContent = label;
  row.append(input, text);
  return { row, input, text };
}

export class CodeEditorSearchPanel implements Panel {
  readonly dom: HTMLDivElement;
  readonly top = true;

  private readonly searchInput = document.createElement('input');
  private readonly replaceInput = document.createElement('input');
  private readonly resultCount = document.createElement('span');
  private readonly replaceRow = document.createElement('div');
  private readonly settingsRow = document.createElement('div');
  private readonly replaceToggle: SearchPanelButton;
  private readonly settingsToggle: SearchPanelButton;
  private readonly previousButton: SearchPanelButton;
  private readonly nextButton: SearchPanelButton;
  private readonly selectButton: SearchPanelButton;
  private readonly replaceButton: SearchPanelButton;
  private readonly replaceAllButton: SearchPanelButton;
  private readonly closeButton: SearchPanelButton;
  private readonly caseOption = makeOption('', 'case');
  private readonly regexpOption = makeOption('', 'regexp');
  private readonly wordOption = makeOption('', 'word');
  private query: SearchQuery;
  private showReplace = false;
  private showSettings = false;
  private canReplace = true;
  private readonly onDestroy?: (panel: CodeEditorSearchPanel) => void;

  constructor(
    private readonly view: EditorView,
    private readonly getLabels: () => CodeEditorSearchPanelLabels,
    onDestroy?: (panel: CodeEditorSearchPanel) => void,
  ) {
    this.onDestroy = onDestroy;
    this.query = getSearchQuery(view.state);
    this.dom = document.createElement('div');
    this.dom.className = 'cm-code-search-panel';
    this.dom.setAttribute('role', 'group');

    const searchRow = document.createElement('div');
    searchRow.className = 'cm-code-search-row';

    this.replaceToggle = makeButton('', 'chevronRight', () => {
      this.showReplace = !this.showReplace;
      this.updateDisclosureState();
    }, 'cm-code-search-disclosure');
    this.replaceToggle.classList.add('cm-code-search-replace-toggle');
    this.searchInput.type = 'text';
    this.searchInput.className = 'cm-code-search-input';
    this.searchInput.name = 'search';
    this.searchInput.setAttribute('main-field', 'true');
    this.searchInput.autocomplete = 'off';
    this.searchInput.spellcheck = false;
    this.searchInput.addEventListener('input', () => this.commitQuery());
    this.searchInput.addEventListener('keydown', (event) => this.handleKeyDown(event));

    this.resultCount.className = 'cm-code-search-count';
    this.resultCount.setAttribute('aria-live', 'polite');
    const searchField = document.createElement('div');
    searchField.className = 'cm-code-search-field';
    searchField.append(this.searchInput, this.resultCount);

    this.previousButton = makeButton('', 'up', () => findPrevious(this.view));
    this.nextButton = makeButton('', 'down', () => findNext(this.view));
    this.selectButton = makeButton('', 'selectAll', () => selectMatches(this.view), 'cm-code-search-select-matches');
    this.settingsToggle = makeButton('', 'settings', () => {
      this.showSettings = !this.showSettings;
      this.updateDisclosureState();
    }, 'cm-code-search-settings-toggle');
    this.closeButton = makeButton('', 'close', () => closeSearchPanel(this.view), 'cm-code-search-close');
    searchRow.append(
      this.replaceToggle,
      searchField,
      this.previousButton,
      this.nextButton,
      this.settingsToggle,
      this.closeButton,
    );

    this.replaceRow.className = 'cm-code-search-expanded-row cm-code-search-replace-row';
    this.replaceInput.type = 'text';
    this.replaceInput.className = 'cm-code-search-input';
    this.replaceInput.name = 'replace';
    this.replaceInput.autocomplete = 'off';
    this.replaceInput.addEventListener('input', () => this.commitQuery());
    this.replaceInput.addEventListener('keydown', (event) => this.handleKeyDown(event));
    const replaceField = document.createElement('div');
    replaceField.className = 'cm-code-search-field';
    replaceField.append(this.replaceInput);
    this.replaceButton = makeButton('', 'replace', () => replaceNext(this.view));
    this.replaceAllButton = makeButton('', 'replaceAll', () => replaceAll(this.view));
    this.replaceRow.append(this.replaceField, this.replaceButton, this.replaceAllButton);

    this.settingsRow.className = 'cm-code-search-expanded-row cm-code-search-settings-row';
    this.settingsRow.setAttribute('role', 'group');
    this.caseOption.input.addEventListener('change', () => this.commitQuery());
    this.regexpOption.input.addEventListener('change', () => this.commitQuery());
    this.wordOption.input.addEventListener('change', () => this.commitQuery());
    this.settingsRow.append(this.caseOption.row, this.regexpOption.row, this.wordOption.row, this.selectButton);

    this.dom.addEventListener('keydown', (event) => this.handleKeyDown(event));
    this.dom.append(searchRow, this.replaceRow, this.settingsRow);
    this.refreshLabels();
    this.syncQuery(this.query);
    this.refreshMatchCount();
    this.updateDisclosureState();
    document.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
  }

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && !this.dom.contains(target)) closeSearchPanel(this.view);
  };

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSearchPanel(this.view);
      return;
    }
    if (event.key !== 'Enter' || (event.target !== this.searchInput && event.target !== this.replaceInput)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target === this.replaceInput) {
      replaceNext(this.view);
    } else if (event.shiftKey) {
      findPrevious(this.view);
    } else {
      findNext(this.view);
    }
  }

  private commitQuery(): void {
    const query = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: this.caseOption.input.checked,
      regexp: this.regexpOption.input.checked,
      wholeWord: this.wordOption.input.checked,
      literal: this.query.literal,
      test: this.query.test,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private syncQuery(query: SearchQuery): void {
    this.query = query;
    this.searchInput.value = query.search;
    this.replaceInput.value = query.replace;
    this.caseOption.input.checked = query.caseSensitive;
    this.regexpOption.input.checked = query.regexp;
    this.wordOption.input.checked = query.wholeWord;
  }

  private refreshMatchCount(): void {
    this.canReplace = !this.view.state.readOnly;
    const selection = this.view.state.selection.main;
    let count = 0;
    let currentIndex = -1;
    let nextIndex = -1;

    if (this.query.valid) {
      const cursor = this.query.getCursor(this.view.state);
      while (true) {
        const result = cursor.next();
        if (result.done) break;
        const match = result.value;
        if (match.from === selection.from && match.to === selection.to) currentIndex = count;
        if (nextIndex < 0 && match.from >= selection.from) nextIndex = count;
        count++;
      }
    }

    const index = currentIndex >= 0 ? currentIndex : (nextIndex >= 0 ? nextIndex : 0);
    this.resultCount.textContent = count > 0 ? `${index + 1}/${count}` : '';
    this.resultCount.hidden = count === 0;
    this.previousButton.disabled = count === 0;
    this.nextButton.disabled = count === 0;
    this.selectButton.disabled = count === 0;
    this.replaceButton.disabled = count === 0 || !this.canReplace;
    this.replaceAllButton.disabled = count === 0 || !this.canReplace;
    this.replaceToggle.hidden = !this.canReplace;
  }

  private updateDisclosureState(): void {
    this.replaceToggle.iconName = this.showReplace ? 'chevronDown' : 'chevronRight';
    this.replaceToggle.replaceChildren(icon(this.replaceToggle.iconName));
    this.replaceToggle.setAttribute('aria-expanded', String(this.showReplace));
    this.replaceRow.hidden = !this.showReplace;
    this.settingsToggle.setAttribute('aria-expanded', String(this.showSettings));
    this.settingsRow.hidden = !this.showSettings;
  }

  refreshLabels(): void {
    const labels = this.getLabels();
    this.searchInput.placeholder = labels.search;
    this.searchInput.setAttribute('aria-label', labels.search);
    this.replaceInput.placeholder = labels.replaceWith;
    this.replaceInput.setAttribute('aria-label', labels.replaceWith);
    this.replaceToggle.title = labels.toggleReplace;
    this.replaceToggle.setAttribute('aria-label', labels.toggleReplace);
    this.settingsToggle.title = labels.moreSettings;
    this.settingsToggle.setAttribute('aria-label', labels.moreSettings);
    this.previousButton.title = labels.previous;
    this.previousButton.setAttribute('aria-label', labels.previous);
    this.nextButton.title = labels.next;
    this.nextButton.setAttribute('aria-label', labels.next);
    this.closeButton.title = labels.close;
    this.closeButton.setAttribute('aria-label', labels.close);
    this.replaceButton.title = labels.replace;
    this.replaceButton.setAttribute('aria-label', labels.replace);
    this.replaceAllButton.title = labels.replaceAll;
    this.replaceAllButton.setAttribute('aria-label', labels.replaceAll);
    this.selectButton.title = labels.selectAllMatches;
    this.selectButton.setAttribute('aria-label', labels.selectAllMatches);
    this.caseOption.text.textContent = labels.matchCase;
    this.regexpOption.text.textContent = labels.regularExpression;
    this.wordOption.text.textContent = labels.wholeWord;
  }

  update(update: ViewUpdate): void {
    const queryChanged = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(setSearchQuery)),
    );
    if (queryChanged) this.syncQuery(getSearchQuery(update.state));
    if (queryChanged || update.docChanged || update.selectionSet) this.refreshMatchCount();
  }

  mount(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.onDestroy?.(this);
  }
}
