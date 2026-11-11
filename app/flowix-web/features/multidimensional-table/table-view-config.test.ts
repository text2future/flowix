import { describe, expect, it } from 'vitest';
import { createTableDocument, createUuidV7 } from './model';
import { addVisibleField, removeFieldFromView, viewRequiresField, visibleFieldIds, withVisibleField } from './table-view-config';

function view(layout: 'table' | 'kanban' | 'calendar' | 'gallery') {
  return {
    id: `view_${createUuidV7()}`,
    name: layout,
    layout,
    filter: { all: [], any: [] },
    sort: [{ field: 'status', direction: 'asc' as const }, { field: 'modified_at', direction: 'desc' as const }],
    config: layout === 'table' || layout === 'gallery'
      ? { visible_fields: ['title', 'status'] }
      : layout === 'kanban' ? { group_by: 'status' } : { date_field: 'status', title_field: 'title' },
  };
}

describe('table view config', () => {
  it('reads visible fields only from layouts that support them', () => {
    expect(visibleFieldIds(view('table'))).toEqual(['title', 'status']);
    expect(visibleFieldIds(view('kanban'))).toEqual([]);
  });

  it('updates visibility without duplicating fields or touching other layouts', () => {
    const table = view('table');
    expect(addVisibleField(table, 'status')).toBe(table);
    expect(addVisibleField(table, 'priority').config.visible_fields).toEqual(['title', 'status', 'priority']);
    expect(withVisibleField(table, 'status', false).config.visible_fields).toEqual(['title']);
    const kanban = view('kanban');
    expect(withVisibleField(kanban, 'status', false)).toBe(kanban);
  });

  it('removes all field references and sort aliases from a view', () => {
    const next = removeFieldFromView(view('table'), 'status', 'state');
    expect(next.config.visible_fields).toEqual(['title']);
    expect(next.sort).toEqual([{ field: 'modified_at', direction: 'desc' }]);
    expect(removeFieldFromView(view('kanban'), 'status').config.group_by).toBeUndefined();
    expect(viewRequiresField(view('calendar'), 'status')).toBe(true);
    expect(viewRequiresField({ ...view('table'), config: { group_by: 'status' } }, 'status')).toBe(false);
  });

  it('keeps the source view immutable', () => {
    const document = createTableDocument();
    const source = document.views.items[0];
    const next = removeFieldFromView(source, 'missing');
    expect(next).toBe(source);
  });
});
