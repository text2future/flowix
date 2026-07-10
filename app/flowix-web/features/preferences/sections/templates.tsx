'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useI18n } from '@features/i18n';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { memos, type MemoTemplate } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';

export function TemplatesSection() {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<MemoTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await memos.listTemplates());
    } catch (error) {
      console.warn('[TemplatesSection] listTemplates failed:', error);
      toast.error(t('preferences.templates.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const handleDelete = async (template: MemoTemplate) => {
    const confirmed = window.confirm(
      t('preferences.templates.deleteConfirm').replace('{name}', template.name),
    );
    if (!confirmed) return;

    setDeletingId(template.id);
    try {
      const deleted = await memos.deleteTemplate(template.id);
      if (deleted) {
        setTemplates((items) => items.filter((item) => item.id !== template.id));
        toast.success(t('preferences.templates.deleteSuccess'));
      } else {
        toast.error(t('preferences.templates.notFound'));
        void loadTemplates();
      }
    } catch (error) {
      console.warn('[TemplatesSection] deleteTemplate failed:', error);
      toast.error(t('preferences.templates.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeader title={t('preferences.templates.title')} />

      {loading ? (
        <p className="py-6 text-sm text-[var(--muted-foreground)]">
          {t('preferences.templates.loading')}
        </p>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileText className="mb-4 h-12 w-12 text-[var(--muted-foreground)]" />
          <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.templates.empty')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex min-h-12 items-center gap-3 border-b border-[var(--divider)] px-3 py-2 last:border-b-0"
            >
              <FileText className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--foreground)]">{template.name}</div>
                <div className="truncate text-xs text-[var(--muted-foreground)]">{template.id}</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                tooltip={t('preferences.templates.delete')}
                aria-label={`${t('preferences.templates.delete')} ${template.name}`}
                disabled={deletingId === template.id}
                onClick={() => void handleDelete(template)}
                className="rounded-md text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
