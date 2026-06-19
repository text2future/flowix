'use client';

import { useState, useEffect } from 'react';
import { Keyboard, Link2, History, Infinity, Type, Palette, Settings } from 'lucide-react';
import { useUserSettings } from '../../lib/hooks/useUserSettings';
import {
	GeneralSection,
	FormatSection,
	ThemeSection,
	AgentSection,
	ShortcutsSection,
	ConnectionsSection,
	HistorySection,
	type SettingsTab,
} from './sections';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { WindowsTitlebarControls } from '../../components/windows-titlebar-controls';
import { PreferencesTitlebarMac } from './preferences-titlebar-mac';
import { PreferencesTitlebarWin } from './preferences-titlebar-win';

function isWindowsPlatform(): boolean {
	return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
	{ id: 'general', label: '通用', icon: <Settings className="w-4 h-4" /> },
	{ id: 'format', label: '排版', icon: <Type className="w-4 h-4" /> },
	{ id: 'theme', label: '主题', icon: <Palette className="w-4 h-4" /> },
	{ id: 'agent', label: 'AI 模型', icon: <Infinity className="w-4 h-4" /> },
	{ id: 'shortcuts', label: '快捷键', icon: <Keyboard className="w-4 h-4" /> },
	{ id: 'connections', label: '连接应用', icon: <Link2 className="w-4 h-4" /> },
	{ id: 'history', label: '历史', icon: <History className="w-4 h-4" /> },
];

interface PreferencesViewProps {
	initialTab?: string;
}

export function PreferencesView({ initialTab }: PreferencesViewProps) {
	const { settings, updateSettings } = useUserSettings();
	const [activeTab, setActiveTab] = useState<SettingsTab>('general');

	useEffect(() => {
		if (initialTab && TABS.some(t => t.id === initialTab)) {
			setActiveTab(initialTab as SettingsTab);
		}
	}, [initialTab]);

	return (
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--background)]">
			<WindowsTitlebarControls />
			{isWindowsPlatform() ? <PreferencesTitlebarWin /> : <PreferencesTitlebarMac />}
			<div className="flex-1 flex min-h-0">
				{/* Left sidebar */}
				<div className="w-[204px] border-r border-solid border-[var(--divider)] bg-[var(--card)] shrink-0 px-2 pt-6 pb-2 space-y-1 flex flex-col">
					{TABS.map((tab) => (
						<Button
							key={tab.id}
							variant={activeTab === tab.id ? 'secondary' : 'ghost'}
							size="sm"
							className={cn(
								'w-full justify-start gap-1.5 py-4 rounded-lg',
								activeTab === tab.id && 'text-[var(--primary)]'
							)}
							onClick={() => setActiveTab(tab.id)}
						>
							{tab.icon}
							<span className="text-sm font-normal">{tab.label}</span>
						</Button>
					))}
				</div>
				{/* Right content */}
				<div className="flex-1 flex flex-col min-w-0">
					<div className="flex-1 flex justify-center p-6 overflow-y-auto">
						<div className="w-full max-w-[500px]">
							{activeTab === 'general' && (
								<GeneralSection
									settings={settings.personalize}
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
