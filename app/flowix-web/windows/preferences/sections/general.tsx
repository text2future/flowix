'use client';

import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '../../../components/ui/select';
import { Textarea } from '../../../components/ui/textarea';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useComposingValue } from '../../../lib/hooks/useComposingValue';
import { product, type ProductInfo } from '../../../lib/tauri/client';
import { toast } from '../../../lib/toast';
import { Field, FieldRow, SectionHeader, FIELD_INPUT_CLASS } from './primitives';

interface GeneralSectionProps {
  settings: {
    customInstruction: string;
    selectedTags: string[];
    responseLength: string;
    preferredLanguage: string;
  };
  updateSettings: (updates: {
    personalize?: Partial<{
      customInstruction: string;
      selectedTags: string[];
      responseLength: string;
      preferredLanguage: string;
    }>;
  }) => Promise<void>;
}

export function GeneralSection({ settings, updateSettings }: GeneralSectionProps) {
  const customInstruction = useComposingValue(
    settings.customInstruction,
    (next) => updateSettings({ personalize: { customInstruction: next } }),
  );
  const [uiLanguage, setUiLanguage] = useState('Simplified Chinese');
  const [productInfo, setProductInfo] = useState<ProductInfo | null>(null);

  useEffect(() => {
    product.getInfo()
      .then(setProductInfo)
      .catch(() => setProductInfo(null));
  }, []);

  const handleOpenLogDir = async () => {
    try {
      await product.openLogDir();
    } catch {
      toast.error('Failed to open log folder');
    }
  };

  return (
    <div className="space-y-6 pb-16">
      <SectionHeader title="General" />

      <FieldRow
        title="Language"
        description="Choose the app display language"
      >
        <Select
          value={uiLanguage}
          onValueChange={setUiLanguage}
        >
          <SelectTrigger className="w-40" />
          <SelectContent>
            <SelectItem value="Simplified Chinese">Simplified Chinese</SelectItem>
            <SelectItem value="English">English</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="Personalization" />

      <Field
        title="Custom instructions"
        description="Tell AI about your role and usage context"
      >
        <Textarea
          value={customInstruction.value}
          onChange={customInstruction.onChange}
          onCompositionStart={customInstruction.onCompositionStart}
          onCompositionEnd={customInstruction.onCompositionEnd}
          placeholder="For example: I am a product manager responsible for requirement analysis..."
          className={FIELD_INPUT_CLASS}
        />
      </Field>

      <FieldRow
        title="Response length"
        description="Control how detailed AI responses should be"
      >
        <Select
          value={settings.responseLength}
          onValueChange={(value) => updateSettings({ personalize: { responseLength: value } })}
        >
          <SelectTrigger className="w-32" />
          <SelectContent>
            <SelectItem value="concise">Concise</SelectItem>
            <SelectItem value="standard">Standard</SelectItem>
            <SelectItem value="detailed">Detailed</SelectItem>
            <SelectItem value="简洁">简洁</SelectItem>
            <SelectItem value="标准">标准</SelectItem>
            <SelectItem value="详细">详细</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow
        title="Preferred language"
        description="Language used by AI responses"
      >
        <Select
          value={settings.preferredLanguage}
          onValueChange={(value) => updateSettings({ personalize: { preferredLanguage: value } })}
        >
          <SelectTrigger className="w-40" />
          <SelectContent>
            <SelectItem value="Simplified Chinese">Simplified Chinese</SelectItem>
            <SelectItem value="English">English</SelectItem>
            <SelectItem value="简体中文">简体中文</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <SectionHeader title="About Flowix" />

      <FieldRow title="Current version">
        <span
          className="max-w-[420px] truncate text-right text-sm text-[var(--muted-foreground)]"
          title={productInfo
            ? `${productInfo.productName} ${productInfo.version} / ${productInfo.os} ${productInfo.arch}`
            : 'Loading'}
        >
          {productInfo
            ? `${productInfo.productName} ${productInfo.version} / ${productInfo.os} ${productInfo.arch}`
            : 'Loading'}
        </span>
      </FieldRow>

      {import.meta.env.DEV && (
        <FieldRow
          title="Runtime logs"
          description={productInfo?.logDir ?? 'Local log folder'}
        >
          <Tooltip content="Open log folder">
            <Button
              variant="outline"
              className="px-3"
              onClick={handleOpenLogDir}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Open
            </Button>
          </Tooltip>
        </FieldRow>
      )}
    </div>
  );
}
