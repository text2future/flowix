'use client';

import { SectionHeader } from '@features/preferences/sections/primitives';
import { Button } from '@shared/ui/button';
import iconNotion from '@/assets/icon-notion.svg';
import iconSlack from '@/assets/icon-slack.svg';
import iconGithub from '@/assets/icon-github.svg';
import iconLinear from '@/assets/icon-linear.svg';
import iconJira from '@/assets/icon-jira.svg';
import iconFigma from '@/assets/icon-figma.png';
import iconGdrive from '@/assets/icon-gdrive.svg';
import { useI18n, type I18nKey } from '@features/i18n';

interface ConnectionItem {
  name: string;
  descriptionKey: I18nKey;
  icon: string;
}

const connectionsList: ConnectionItem[] = [
  { name: 'Notion', descriptionKey: 'preferences.connections.notion.description', icon: iconNotion },
  { name: 'Slack', descriptionKey: 'preferences.connections.slack.description', icon: iconSlack },
  { name: 'GitHub', descriptionKey: 'preferences.connections.github.description', icon: iconGithub },
  { name: 'Linear', descriptionKey: 'preferences.connections.linear.description', icon: iconLinear },
  { name: 'Jira', descriptionKey: 'preferences.connections.jira.description', icon: iconJira },
  { name: 'Figma', descriptionKey: 'preferences.connections.figma.description', icon: iconFigma },
  { name: 'Google Drive', descriptionKey: 'preferences.connections.googleDrive.description', icon: iconGdrive },
];

export function ConnectionsSection() {
  const { t } = useI18n();

  return (
    <div className="space-y-4 pb-6">
      <SectionHeader title={t('preferences.connections.title')} />
      <div className="divide-y divide-[var(--divider)]">
        {connectionsList.map((item) => (
          <div
            key={item.name}
            className="flex items-center justify-between gap-4 py-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              <img
                src={item.icon}
                alt={item.name}
                className="h-7 w-7 shrink-0 rounded-md object-contain"
              />
              <div className="min-w-0">
                <div className="text-sm font-normal text-[var(--foreground)]">
                  {item.name}
                </div>
                <div className="text-sm text-[var(--muted-foreground)]">
                  {t(item.descriptionKey)}
                </div>
              </div>
            </div>
            <Button variant="outline" className="px-3" disabled>
              {t('preferences.connections.connect')}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
