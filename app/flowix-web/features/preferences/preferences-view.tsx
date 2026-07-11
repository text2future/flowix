'use client';

import { useState, useEffect } from 'react';
import { FileCog, Keyboard, Link2, History, SquareTerminal, SquareMousePointer, Type, Palette, Settings } from 'lucide-react';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import {
	GeneralSection,
	FormatSection,
	ThemeSection,
	NoteSettingsSection,
	AgentsSection,
	ShortcutsSection,
	CliSection,
	ConnectionsSection,
	HistorySection,
	SectionHeader,
	type SettingsTab,
} from '@features/preferences/sections';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { PreferencesTitlebarMac } from '@features/preferences/preferences-titlebar-mac';
import { PreferencesTitlebarWin } from '@features/preferences/preferences-titlebar-win';
import { useI18n, type I18nKey } from '@features/i18n';
import { AgentIconStack } from '@features/agent/components/agent-icon-stack';
import { getCurrentWindow } from '@tauri-apps/api/window';

function isWindowsPlatform(): boolean {
	return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

type PreferencesTabItem = { id: SettingsTab; labelKey: I18nKey; icon: React.ReactNode };

const TAB_GROUPS: { labelKey: I18nKey; tabs: PreferencesTabItem[] }[] = [
	{
		labelKey: 'preferences.groups.features',
		tabs: [
			{ id: 'general', labelKey: 'preferences.tabs.general', icon: <Settings className="w-4 h-4" /> },
			{ id: 'format', labelKey: 'preferences.tabs.format', icon: <Type className="w-4 h-4" /> },
			{ id: 'theme', labelKey: 'preferences.tabs.theme', icon: <Palette className="w-4 h-4" /> },
			{ id: 'noteSettings', labelKey: 'preferences.tabs.noteSettings', icon: <FileCog className="w-4 h-4" /> },
			{ id: 'shortcuts', labelKey: 'preferences.tabs.shortcuts', icon: <Keyboard className="w-4 h-4" /> },
			{ id: 'history', labelKey: 'preferences.tabs.history', icon: <History className="w-4 h-4" /> },
		],
	},
	{
		labelKey: 'preferences.groups.ai',
		tabs: [
			// 模型配置整段塞到 aiAgent 的 Flowix 卡片里, 不再独立成 tab。
			{ id: 'aiAgent', labelKey: 'preferences.tabs.aiAgent', icon: <AgentIconStack /> },
			{ id: 'cli', labelKey: 'preferences.tabs.cli', icon: <SquareTerminal className="w-4 h-4" /> },
			{ id: 'connections', labelKey: 'preferences.tabs.connections', icon: <Link2 className="w-4 h-4" /> },
			{ id: 'tools', labelKey: 'preferences.tabs.tools', icon: <SquareMousePointer className="w-4 h-4" /> },
		],
	},
];

const TABS = TAB_GROUPS.flatMap(group => group.tabs);

function normalizeInitialTab(tab: string): SettingsTab | null {
	if (tab === 'templates' || tab === 'documentProperties') return 'noteSettings';
	// 老 URL: `agent` / `modelConfig` 都是模型配置, 落到合并后的 `aiAgent`。
	if (tab === 'agent' || tab === 'modelConfig' || tab === 'agents') return 'aiAgent';
	// 老 URL: 图片 / 视频生成合并到 `tools`。
	if (tab === 'imageGeneration' || tab === 'videoGeneration') return 'tools';
	return TABS.some(item => item.id === tab) ? tab as SettingsTab : null;
}

function PlaceholderSection({ title, emptyText }: { title: string; emptyText: string }) {
	return (
		<div className="space-y-6">
			<SectionHeader title={title} />
			<p className="text-sm text-[var(--muted-foreground)]">{emptyText}</p>
		</div>
	);
}

interface PreferencesViewProps {
	initialTab?: string;
}

export function PreferencesView({ initialTab }: PreferencesViewProps) {
	const { settings, updateSettings } = useUserSettings();
	const { t } = useI18n();
	const [activeTab, setActiveTab] = useState<SettingsTab>('general');
	const title = t('preferences.title');

	useEffect(() => {
		if (initialTab) {
			const normalizedTab = normalizeInitialTab(initialTab);
			if (normalizedTab) setActiveTab(normalizedTab);
		}
	}, [initialTab]);

	useEffect(() => {
		document.title = title;
		void getCurrentWindow().setTitle(title).catch(() => {
			// Browser preview or unavailable Tauri window API.
		});
	}, [title]);

	return (
		<div className="flex h-screen w-screen select-none flex-col overflow-hidden bg-[var(--background)]">
			<WindowsTitlebarControls />
			{isWindowsPlatform() ? <PreferencesTitlebarWin /> : <PreferencesTitlebarMac />}
			<div className="flex-1 flex min-h-0">
				{/* Left sidebar */}
				<div className="w-[204px] min-h-0 overflow-y-auto [scrollbar-gutter:stable] border-r border-solid border-[var(--divider)] bg-[var(--card)] shrink-0 px-2 pt-5 pb-2 flex flex-col gap-4">
					{TAB_GROUPS.map((group) => (
						<div key={group.labelKey} className="space-y-1">
							<div className="px-2 pb-1 text-xs font-medium text-[var(--muted-foreground)]">
								{t(group.labelKey)}
							</div>
							{group.tabs.map((tab) => (
								<Button
									key={tab.id}
									// 始终走 ghost 变体, 选中态手动叠加 bg-muted 跟 ghost 的 hover
									// 同色, 在 light/dark 主题下都保持视觉一致。
									variant="ghost"
									size="sm"
									className={cn(
										'w-full justify-start gap-1.5 py-4 rounded-lg',
										activeTab === tab.id &&
											'bg-muted text-[var(--primary)] hover:bg-muted dark:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)]'
									)}
									onClick={() => setActiveTab(tab.id)}
								>
									{tab.icon}
									<span className="text-sm font-normal">{t(tab.labelKey)}</span>
								</Button>
							))}
						</div>
					))}
				</div>
				{/* Right content */}
				<div className="flex-1 flex flex-col min-w-0">
					<div className="flex-1 flex justify-center p-6 overflow-y-auto [scrollbar-gutter:stable]">
						<div className="w-full max-w-[500px]">
							{activeTab === 'general' && (
								<GeneralSection
									settings={settings.personalize}
									language={settings.language}
									region={settings.region}
									memoCardVariant={settings.memoCardVariant}
									updateSettings={updateSettings}
								/>
							)}
							{activeTab === 'format' && (
								<FormatSection
									settings={settings.format}
									updateSettings={updateSettings}
								/>
							)}
							{activeTab === 'theme' && (
								<ThemeSection
									settings={settings}
									updateSettings={updateSettings}
								/>
							)}
							{activeTab === 'noteSettings' && <NoteSettingsSection />}
							{activeTab === 'aiAgent' && <AgentsSection />}
							{activeTab === 'shortcuts' && <ShortcutsSection />}
							{activeTab === 'cli' && <CliSection />}
							{activeTab === 'connections' && <ConnectionsSection />}
							{activeTab === 'tools' && (
								<div className="space-y-8">
									<PlaceholderSection
										title={t('preferences.imageGeneration.title')}
										emptyText={t('preferences.emptySettings')}
									/>
									<PlaceholderSection
										title={t('preferences.videoGeneration.title')}
										emptyText={t('preferences.emptySettings')}
									/>
								</div>
							)}
							{activeTab === 'history' && <HistorySection />}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
