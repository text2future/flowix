'use client';

import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '../../../components/ui/select';
import { Textarea } from '../../../components/ui/textarea';
import { Field, FieldRow, FIELD_INPUT_CLASS } from './primitives';

interface PersonalizeSectionProps {
  settings: {
    customInstruction: string;
    selectedTags: string[];
    responseLength: string;
    preferredLanguage: string;
  };
  updateSettings: (updates: Partial<{
    customInstruction: string;
    selectedTags: string[];
    responseLength: string;
    preferredLanguage: string;
  }>) => Promise<void>;
}

export function PersonalizeSection({ settings, updateSettings }: PersonalizeSectionProps) {
  return (
    <div className="space-y-6">
      {/* Custom Instructions */}
      <Field
        title="Custom Instructions"
        description="Tell AI about your role and use cases to get more relevant responses"
      >
        <Textarea
          value={settings.customInstruction}
          onChange={(e) => updateSettings({ customInstruction: e.target.value })}
          placeholder="e.g., I'm a product manager focused on requirements analysis..."
          className={FIELD_INPUT_CLASS}
        />
      </Field>

      {/* Response Length */}
      <FieldRow
        title="Response Length"
        description="Control AI response detail level"
      >
        <Select
          value={settings.responseLength}
          onValueChange={(value) => updateSettings({ responseLength: value })}
        >
          <SelectTrigger className="w-32" />
          <SelectContent>
            <SelectItem value="Concise">Concise</SelectItem>
            <SelectItem value="Standard">Standard</SelectItem>
            <SelectItem value="Detailed">Detailed</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      {/* Preferred Language */}
      <FieldRow
        title="Preferred Language"
        description="Language for AI responses"
      >
        <Select
          value={settings.preferredLanguage}
          onValueChange={(value) => updateSettings({ preferredLanguage: value })}
        >
          <SelectTrigger className="w-32" />
          <SelectContent>
            <SelectItem value="简体中文">简体中文</SelectItem>
            <SelectItem value="English">English</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
    </div>
  );
}
