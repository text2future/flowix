'use client';

import { useState } from 'react';
import {
  Sparkles,
  Keyboard,
  Link2,
  X,
  History,
  Bot,
  Type,
  Palette,
} from 'lucide-react';
import { useUserSettings } from '../../lib/hooks/useUserSettings';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import {
  GeneralSection,
  FormatSection,
  ThemeSection,
  AgentSection,
  ShortcutsSection,
  ConnectionsSection,
  HistorySection,
  type SettingsTab,
} from '../preferences/sections';

interface TabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabItem[] = [
  { id: 'general', label: '通用', icon: <Sparkles className="w-4 h-4" /> },
  { id: 'format', label: '排版', icon: <Type className="w-4 h-4" /> },
  { id: 'theme', label: '主题', icon: <Palette className="w-4 h-4" /> },
  { id: 'agent', label: '智能体', icon: <Bot className="w-4 h-4" /> },
  { id: 'shortcuts', label: '快捷键', icon: <Keyboard className="w-4 h-4" /> },
  { id: 'connections', label: '连接应用', icon: <Link2 className="w-4 h-4" /> },
  { id: 'history', label: '历史', icon: <History className="w-4 h-4" /> },
];

interface MenuBoardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Main-window command palette (Cmd+K). Renders the same settings sections
 * that the dedicated Preferences window uses, but in a centered overlay
 * instead of a separate Tauri window.
 *
 * The tab *content* lives in `windows/preferences/sections/` so both surfaces
 * share a single source of truth. This file owns only the popup shell:
 * overlay, sidebar, tab switching, close button.
 */
export function MenuBoard({ open, onOpenChange }: MenuBoardProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { settings, updateSettings } = useUserSettings();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* (蒙层已移除) */}

      {/* 外层用 --popover 抬高自主窗口 (主窗口的 memo 列表列 = --card), 让命令面板
       * 视觉上"浮"在主页面之上, 三个主题在 css/theme/*.css 的 --popover 定义中
       * 统一调色, 这里只引用 token, 不写具体颜色. */}
      <div className="relative w-full h-full bg-[var(--popover)] text-[var(--popover-foreground)] border border-[var(--border)] shadow-2xl flex justify-center">
        <div className="w-full max-w-[800px] flex overflow-hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="absolute top-2 right-3 z-10"
          >
            <X className="w-5 h-5" />
          </Button>

          {/* Left sidebar */}
          <div className="w-56 border-r border-[var(--border)] p-4 bg-[var(--card)] shrink-0 flex flex-col">
            <div className="text-sm text-[var(--muted-foreground)] mb-3 pl-3 pt-[50px] pb-[20px] font-light">
              偏好设置
            </div>
            {TABS.map((tab) => (
              <Button
                key={tab.id}
                variant={activeTab === tab.id ? 'secondary' : 'ghost'}
                size="sm"
                className={cn(
                  'w-full justify-start gap-3 mb-2 rounded-lg',
                  activeTab === tab.id && 'text-[var(--primary)]'
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon}
                <span className="text-sm">{tab.label}</span>
              </Button>
            ))}
          </div>

          {/* Right content */}
          <div className="flex-1 flex justify-center pt-[36px] pb-3 px-12">
            <div className="w-full max-w-[800px]">
              {activeTab === 'general' && (
                <GeneralSection settings={settings.personalize} updateSettings={updateSettings} />
              )}
              {activeTab === 'format' && (
                <FormatSection settings={settings.format} updateSettings={updateSettings} />
              )}
              {activeTab === 'theme' && (
                <ThemeSection settings={settings} updateSettings={updateSettings} />
              )}
              {activeTab === 'agent' && <AgentSection />}
              {activeTab === 'shortcuts' && <ShortcutsSection />}
              {activeTab === 'connections' && <ConnectionsSection />}
              {activeTab === 'history' && <HistorySection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
