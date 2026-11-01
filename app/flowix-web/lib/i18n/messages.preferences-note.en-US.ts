import type zhCN from './messages.preferences-note.zh-CN';

/**
 * English counterpart of the preferences note-group message shard. The type
 * annotation keeps its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "preferences.groups.notes": "Notes",
  "preferences.tabs.noteOther": "Other settings",
  "preferences.noteOther.interface": "Note management",
  "preferences.noteOther.notebook.title": "Notebook",
  "preferences.noteOther.createLocation.label": "Default note location",
  "preferences.noteOther.createLocation.description": "Folder where new notes are written from the note list",
  "preferences.noteOther.indexSection": "Note indexing",
  "preferences.noteOther.indexDescription": "Hidden folders are not indexed: they don't appear in the note list and can't be searched, but they remain accessible",
  "preferences.noteOther.spaceSection": "Browse space display",
  "preferences.noteOther.spaceHiddenFolders.label": "Show hidden folders in the browse space",
  "preferences.noteOther.spaceHiddenFolders.description": "Local folders whose names start with a dot (.)",
  "preferences.noteOther.spaceSystemFolders.label": "Show system folders in the browse space",
  "preferences.noteOther.spaceSystemFolders.description": "attachments, node_modules, __pycache__, etc.",
  "preferences.noteOther.createLocation.pickerTitle": "Default create location",
  "preferences.noteOther.rootFolder": "Notebook root",
  "preferences.noteOther.expandFolder": "Expand folder",
  "preferences.noteOther.collapseFolder": "Collapse folder",
  "preferences.noteOther.saved": "Default create location updated",
  "preferences.noteOther.saveFailed": "Failed to save the default create location",
  "preferences.noteOther.loadFailed": "Could not load settings. Try again.",
  "preferences.noteOther.noNotebooks": "No notebooks yet",
};

export default enUS;
