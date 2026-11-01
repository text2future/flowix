import { createTableDocument, findKanbanStatusField, parseTableDocument, type MultidimensionalTableDocument } from './model';
import { NOTE_CALENDAR_DATE_FIELD_ID, NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID } from './builtin-fields';

export const calendarDateChoices = [
  { id: NOTE_CALENDAR_DATE_FIELD_ID, label: '日期' },
  { id: NOTE_CREATED_AT_FIELD_ID, label: '创建时间', readOnly: true },
  { id: NOTE_UPDATED_AT_FIELD_ID, label: '更新时间', readOnly: true },
];
export function collectionNoteViewOptions(source: string | undefined, type: 'calendar' | 'kanban' | null) {
  let document = createTableDocument();
  if (source) document = parseTableDocument(source);
  return noteViewOptions(document, type);
}
export function noteViewOptions(document: MultidimensionalTableDocument, type: 'calendar' | 'kanban' | null) {
  const statusField = findKanbanStatusField(document);
  const fields = document.dataset.schema.fields;
  const viewFieldChoices = type === 'calendar'
    ? fields.filter((field) => field.type === 'Date' && field.id !== NOTE_CALENDAR_DATE_FIELD_ID
      && field.property_key?.trim().toLowerCase() !== 'calendar_date')
    : type === 'kanban' ? [...(statusField?.type === 'Select' ? [statusField] : []),
      ...fields.filter((field) => field.type === 'Select' && field.id !== statusField?.id)] : [];
  return { statusField, viewFieldChoices };
}
