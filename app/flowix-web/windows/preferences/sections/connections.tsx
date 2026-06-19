'use client';

import { SectionHeader } from './primitives';
import { Button } from '../../../components/ui/button';
import iconNotion from '../../../assets/icon-notion.svg';
import iconSlack from '../../../assets/icon-slack.svg';
import iconGithub from '../../../assets/icon-github.svg';
import iconLinear from '../../../assets/icon-linear.svg';
import iconJira from '../../../assets/icon-jira.svg';
import iconFigma from '../../../assets/icon-figma.png';
import iconGdrive from '../../../assets/icon-gdrive.svg';

interface ConnectionItem {
  name: string;
  description: string;
  icon: string;
}

const connectionsList: ConnectionItem[] = [
  { name: 'Notion', description: '知识管理', icon: iconNotion },
  { name: 'Slack', description: '团队沟通', icon: iconSlack },
  { name: 'GitHub', description: '代码托管', icon: iconGithub },
  { name: 'Linear', description: '项目管理', icon: iconLinear },
  { name: 'Jira', description: '缺陷追踪', icon: iconJira },
  { name: 'Figma', description: '设计协作', icon: iconFigma },
  { name: 'Google Drive', description: '云端文档', icon: iconGdrive },
];

export function ConnectionsSection() {
  return (
    <div className="space-y-4 pb-6">
      <SectionHeader title="连接应用" />
      <div className="divide-y divide-[var(--divider)]">
        {connectionsList.map((item) => (
          <div
            key={item.name}
            className="flex items-center justify-between gap-4 py-3 transition-colors hover:bg-[color-mix(in_oklch,var(--muted)_40%,transparent)]"
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
                  {item.description}
                </div>
              </div>
            </div>
            <Button variant="outline" className="px-3">
              连接
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
