'use client';

import { DocumentPropertiesSection } from '@features/preferences/sections/document-properties';
import { TemplatesSection } from '@features/preferences/sections/templates';

export function NoteSettingsSection() {
  return (
    <div className="space-y-8">
      <TemplatesSection />
      <DocumentPropertiesSection />
    </div>
  );
}
