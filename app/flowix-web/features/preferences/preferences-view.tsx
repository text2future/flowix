'use client';

import { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import {
	useUserSettings,
	useUserSettingsActions,
} from '@features/preferences/hooks/use-user-settings';
import {
	GeneralSection,
	ThemeSection,
	NoteSettingsSection,
	AgentsSection,
	DshSettingsSection,
	PiSettingsSection,
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
import { PREFERENCE_TAB_GROUPS, PREFERENCE_TABS } from '@features/preferences/preferences-tab-config';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { PreferencesTitlebarMac } from '@features/preferences/preferences-titlebar-mac';
import { PreferencesTitlebarWin } from '@features/preferences/preferences-titlebar-win';
import { useI18n } from '@/lib/i18n';
import { getCurrentWindow } from '@platform/tauri/window';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';

function isWindowsPlatform(): boolean {
	return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

const TABS = PREFERENCE_TABS;
const FormatSection = lazy(() =>
	import('@features/preferences/sections/format').then((module) => ({ default: module.FormatSection })),
);

function normalizeInitialTab(tab: string): SettingsTab | null {
	if (tab === 'templates' || tab === 'documentProperties' || tab === 'fileDisplayRules') return 'noteSettings';
	if (tab === 'theme') return 'general';
	if (tab === 'cli') return 'mcp';
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
	const language = useUserSettings((settings) => settings.language);
	const { updateSettings } = useUserSettingsActions();
	return <GeneralSection language={language} updateSettings={updateSettings} afterGeneral={<ThemeSettingsSection />} />;
}

function FormatSettingsSection() {
	const { t } = useI18n();
	const format = useUserSettings((settings) => settings.format);
	const { updateSettings } = useUserSettingsActions();
	return (
		<Suspense
			fallback={(
				<div className="space-y-6" aria-busy="true">
					<SectionHeader title={t('preferences.format.title')} />
					<div className="flex h-48 items-center justify-center" role="status" aria-label={t('preferences.general.loading')}>
						<Loader2 className="size-6 animate-spin text-[var(--muted-foreground)]" />
						<span className="sr-only">{t('preferences.general.loading')}</span>
					</div>
				</div>
			)}
		>
			<FormatSection settings={format} updateSettings={updateSettings} />
		</Suspense>
	);
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
	const refreshRuntimeStatus = useAgentRuntimeStore((state) => state.refreshIfStale);
	const [activeTab, setActiveTab] = useState<SettingsTab>('general');
	const title = t('preferences.title');
	const initialTabName = initialTab?.split('?')[0];
	const autoUpdateDsh = initialTab?.includes('autoUpdate=1') ?? false;

	useEffect(() => {
		void refreshRuntimeStatus();
	}, [refreshRuntimeStatus]);

	const visibleTabGroups = useMemo(
		() => PREFERENCE_TAB_GROUPS.map((group) => ({
			...group,
			tabs: experimental
				? group.tabs
				: group.tabs.filter((tab) => !['cloudSync', 'connections', 'tools', 'history'].includes(tab.id)),
		})),
		[experimental],
	);
	const tabsWithRuntimeAvailability = visibleTabGroups;

	useEffect(() => {
		if (initialTab) {
			const normalizedTab = normalizeInitialTab(initialTabName ?? initialTab);
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
				<OverlayScrollbar
					className="flex h-full w-[204px] min-h-0 shrink-0 border-r border-solid border-[var(--divider)] bg-[var(--card)]"
					scrollerClassName="h-full min-h-0 px-2 pt-5 pb-2"
				>
					<div className="flex min-h-full flex-col gap-4">
						{tabsWithRuntimeAvailability.map((group) => (
							<div key={group.labelKey} className="space-y-1">
								<div className="px-2 pb-1 text-xs font-medium text-[var(--muted-foreground)]">
									{t(group.labelKey)}
								</div>
								<div className="space-y-0.5">
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
							</div>
						))}
					</div>
				</OverlayScrollbar>
				{/* Right content */}
				<div className="h-full min-w-0 min-h-0 flex-1">
					<OverlayScrollbar className="h-full w-full min-h-0" scrollerClassName="h-full min-h-0">
						<div className="min-h-full">
							<div className="flex justify-center p-6 pb-0">
								{/* DSH 页信息密度更高(模型/插件/预设卡片), 放宽到 760px, 其余 tab 保持 500px。 */}
								<div className={cn('w-full', ['dsh', 'codex', 'pi'].includes(activeTab) ? 'max-w-[760px]' : 'max-w-[500px]')}>
									{activeTab === 'general' && <GeneralSettingsSection />}
									{activeTab === 'format' && <FormatSettingsSection />}
									{activeTab === 'noteSettings' && <NoteSettingsSection />}
									{activeTab === 'aiAgent' && <AgentsSection />}
									{activeTab === 'dsh' && <DshSettingsSection autoUpdate={autoUpdateDsh} />}
									{activeTab === 'pi' && <PiSettingsSection />}
									{activeTab === 'shortcuts' && <ShortcutsSection />}
									{activeTab === 'mcp' && (
										<div className="space-y-8">
											<McpSection />
											<CliSection />
										</div>
									)}
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
						{/* 独立尾部块确保 WebKit 将留白计入 scrollHeight。 */}
						<div aria-hidden="true" style={{ height: '2.5rem' }} />
					</OverlayScrollbar>
				</div>
			</div>
		</div>
	);
}
