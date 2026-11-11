import type { TableView } from './model';

/** Returns configured field ids without exposing the loosely typed view config. */
export function visibleFieldIds(view: TableView): string[] {
  if (view.layout !== 'table' && view.layout !== 'gallery') return [];
  return Array.isArray(view.config.visible_fields)
    ? view.config.visible_fields.filter((id): id is string => typeof id === 'string')
    : [];
}

export function viewRequiresField(view: TableView, fieldId: string): boolean {
  if (view.layout === 'kanban') return view.config.group_by === fieldId;
  if (view.layout === 'calendar') {
    return view.config.date_field === fieldId || view.config.title_field === fieldId;
  }
  return false;
}

const FIELD_REFERENCE_CONFIG_KEYS = ['group_by', 'date_field', 'title_field'] as const;

/** Remove a field from every place where a view can reference it. */
export function removeFieldFromView(view: TableView, fieldId: string, propertyKey?: string): TableView {
  const config = { ...view.config };
  let changed = false;
  for (const key of FIELD_REFERENCE_CONFIG_KEYS) {
    if (config[key] === fieldId) {
      delete config[key];
      changed = true;
    }
  }
  if (view.layout === 'table' || view.layout === 'gallery') {
    const fields = visibleFieldIds(view);
    const nextFields = fields.filter((id) => id !== fieldId);
    if (nextFields.length !== fields.length) {
      config.visible_fields = nextFields;
      changed = true;
    }
  }
  const sortFields = new Set([fieldId, propertyKey].filter((value): value is string => Boolean(value)));
  const nextSort = view.sort.filter((item) => !sortFields.has(item.field));
  if (nextSort.length !== view.sort.length) changed = true;
  return changed ? { ...view, config, sort: nextSort } : view;
}

export function addVisibleField(view: TableView, fieldId: string): TableView {
  if (view.layout !== 'table') return view;
  const fields = visibleFieldIds(view);
  if (fields.includes(fieldId)) return view;
  return { ...view, config: { ...view.config, visible_fields: [...fields, fieldId] } };
}

export function removeVisibleField(view: TableView, fieldId: string): TableView {
  if (view.layout !== 'table' && view.layout !== 'gallery') return view;
  const fields = visibleFieldIds(view);
  const nextFields = fields.filter((id) => id !== fieldId);
  if (nextFields.length === fields.length) return view;
  return { ...view, config: { ...view.config, visible_fields: nextFields } };
}

export function withVisibleField(view: TableView, fieldId: string, visible: boolean): TableView {
  return visible ? addVisibleField(view, fieldId) : removeVisibleField(view, fieldId);
}
