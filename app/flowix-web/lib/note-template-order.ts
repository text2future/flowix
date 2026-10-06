const STORAGE_KEY = 'flowix.note-template-order';

export function readNoteTemplateOrder(): string[] {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = value ? JSON.parse(value) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export function orderNoteTemplates<T extends { id: string }>(templates: T[], order = readNoteTemplateOrder()): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return templates
    .map((template, index) => ({ template, index, rank: rank.get(template.id) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ template }) => template);
}

export function saveNoteTemplateOrder(templates: Array<{ id: string }>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates.map((template) => template.id)));
  } catch {
    // Keep reordering usable when storage is unavailable; it will be session-only.
  }
}
