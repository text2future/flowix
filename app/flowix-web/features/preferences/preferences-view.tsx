'use client';

import { useState, useEffect, useMemo } from 'react';
import { PlugIcon, StarFourIcon } from '@phosphor-icons/react';
import { Cloud, FileCog, Keyboard, Link2, History, SquareTerminal, SquareMousePointer, Type, Palette, Settings } from 'lucide-react';
import {
	useUserSettings,
	useUserSettingsActions,
} from '@features/preferences/hooks/use-user-settings';
import {
	GeneralSection,
	FormatSection,
	ThemeSection,
	NoteSettingsSection,
	AgentsSection,
	DshSettingsSection,
	CodexSettingsSection,
	ShortcutsSection,
	CliSection,
	McpSection,
	ConnectionsSection,
	CloudSyncSection,
	HistorySection,
	PluginsSection,
	SectionHeader,
	type SettingsTab,
} from '@features/preferences/sections';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { PreferencesTitlebarMac } from '@features/preferences/preferences-titlebar-mac';
import { PreferencesTitlebarWin } from '@features/preferences/preferences-titlebar-win';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getCurrentWindow } from '@platform/tauri/window';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { AgentIcon } from '@features/agent/components/agent-icon';

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
			{ id: 'cloudSync', labelKey: 'preferences.tabs.cloudSync', icon: <Cloud className="w-4 h-4" /> },
		],
	},
	{
		labelKey: 'preferences.groups.ai',
		tabs: [
			{
				id: 'codex',
				labelKey: 'preferences.tabs.codex',
				icon: <AgentIcon typeKey="codex" alt="" className="h-4 w-4 object-contain" />,
			},
			{
				id: 'dsh',
				labelKey: 'preferences.tabs.dsh',
				icon: <AgentIcon typeKey="deepseek-harness" alt="" className="h-4 w-4 object-contain" />,
			},
			// 模型配置整段塞到 aiAgent 的 Flowix 卡片里, 不再独立成 tab。
			{ id: 'aiAgent', labelKey: 'preferences.tabs.aiAgent', icon: <StarFourIcon className="w-4 h-4" weight="regular" /> },
			{ id: 'cli', labelKey: 'preferences.tabs.cli', icon: <SquareTerminal className="w-4 h-4" /> },
			{ id: 'mcp', labelKey: 'preferences.tabs.mcp', icon: <PlugIcon className="w-4 h-4" /> },
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

function GeneralSettingsSection() {
	const personalize = useUserSettings((settings) => settings.personalize);
	const language = useUserSettings((settings) => settings.language);
	const region = useUserSettings((settings) => settings.region);
	const memoCardVariant = useUserSettings((settings) => settings.memoCardVariant);
	const { updateSettings } = useUserSettingsActions();
	return (
		<GeneralSection
			settings={personalize}
			language={language}
			region={region}
			memoCardVariant={memoCardVariant}
			updateSettings={updateSettings}
		/>
	);
}

function FormatSettingsSection() {
	const format = useUserSettings((settings) => settings.format);
	const { updateSettings } = useUserSettingsActions();
	return <FormatSection settings={format} updateSettings={updateSettings} />;
}

function ThemeSettingsSection() {
	const theme = useUserSettings((settings) => settings.theme);
	const { updateSettings } = useUserSettingsActions();
	return <ThemeSection settings={{ theme }} updateSettings={updateSettings} />;
}

interface PreferencesViewProps {
	initialTab?: string;
}

export function PreferencesView({ initialTab }: PreferencesViewProps) {
	const { t } = useI18n();
	const experimental = useExperimentalMode();
	const [activeTab, setActiveTab] = useState<SettingsTab>('general');
	const title = t('preferences.title');
	const visibleTabGroups = useMemo(
		() => TAB_GROUPS.map((group) => ({
			...group,
			tabs: experimental
				? group.tabs
				: group.tabs.filter((tab) => !['cloudSync', 'connections', 'tools', 'history'].includes(tab.id)),
		})),
		[experimental],
	);

	useEffect(() => {
		if (initialTab) {
			const normalizedTab = normalizeInitialTab(initialTab);
			if (normalizedTab && (normalizedTab !== 'cloudSync' || experimental)) {
				setActiveTab(normalizedTab);
			}
		}
	}, [experimental, initialTab]);

	useEffect(() => {
		if (!experimental && ['cloudSync', 'connections', 'tools', 'history'].includes(activeTab)) {
			setActiveTab('general');
		}
	}, [activeTab, experimental]);

	useEffect(() => {
		document.title = title;
		void getCurrentWindow().setTitle(title).catch(() => {
			// Browser preview or unavailable Tauri window API.
		});
	}, [title]);

	return (
		<div className="flex h-screen w-screen select-none flex-col overflow-hidden bg-[var(--background)]">
			<WindowsTitlebarControls showBottomBorder />
			{isWindowsPlatform() ? <PreferencesTitlebarWin /> : <PreferencesTitlebarMac />}
			<div className="flex-1 flex min-h-0">
				{/* Left sidebar */}
				<div className="w-[204px] min-h-0 overflow-y-auto [scrollbar-gutter:stable] border-r border-solid border-[var(--divider)] bg-[var(--card)] shrink-0 px-2 pt-5 pb-2 flex flex-col gap-4">
					{visibleTabGroups.map((group) => (
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
											'bg-muted hover:bg-muted dark:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)]'
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
						{/* DSH 页信息密度更高(模型/插件/预设卡片), 放宽到 680px, 其余 tab 保持 500px。

						    底部间距放在这个子元素上 (mb), 不放在外层滚动容器的 pb ──
						    WKWebView 会忽略 flex 滚动容器的 padding-bottom, margin 则正常生效 */}
						<div className={cn('mb-10 w-full', ['dsh', 'codex'].includes(activeTab) ? 'max-w-[760px]' : 'max-w-[500px]')}>
							{activeTab === 'general' && (
								<GeneralSettingsSection />
							)}
							{activeTab === 'format' && (
								<FormatSettingsSection />
							)}
							{activeTab === 'theme' && (
								<ThemeSettingsSection />
							)}
							{activeTab === 'noteSettings' && <NoteSettingsSection />}
							{activeTab === 'aiAgent' && <AgentsSection />}
							{activeTab === 'dsh' && <DshSettingsSection />}
							{activeTab === 'codex' && <CodexSettingsSection />}
							{activeTab === 'shortcuts' && <ShortcutsSection />}
							{activeTab === 'cli' && <CliSection />}
							{activeTab === 'mcp' && <McpSection />}
							{activeTab === 'connections' && <ConnectionsSection />}
							{experimental && activeTab === 'cloudSync' && <CloudSyncSection />}
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
			{activeTab === 'plugins' && <PluginsSection />}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
