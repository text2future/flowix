'use client';

import { useState, useEffect } from 'react';
import { Sparkles, Keyboard, Link2, History, Bot, Type, Palette } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import {
	PersonalizeSection,
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
	{ id: 'format', label: 'Format', icon: <Type className="w-4 h-4" /> },
	{ id: 'theme', label: 'Theme', icon: <Palette className="w-4 h-4" /> },
	{ id: 'personalize', label: '个性化', icon: <Sparkles className="w-4 h-4" /> },
	{ id: 'agent', label: 'Agent Config', icon: <Bot className="w-4 h-4" /> },
	{ id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="w-4 h-4" /> },
	{ id: 'connections', label: 'Connections', icon: <Link2 className="w-4 h-4" /> },
	{ id: 'history', label: 'History', icon: <History className="w-4 h-4" /> },
];

interface PreferencesViewProps {
	initialTab?: string;
}

export function PreferencesView({ initialTab }: PreferencesViewProps) {
	const { settings, updateSettings } = useUserSettings();
	const [activeTab, setActiveTab] = useState<SettingsTab>('personalize');

	useEffect(() => {
		if (initialTab && TABS.some(t => t.id === initialTab)) {
			setActiveTab(initialTab as SettingsTab);
		}
	}, [initialTab]);

	return (
		<div className="w-full h-full flex flex-col bg-[var(--background)]">
			<WindowsTitlebarControls />
			{isWindowsPlatform() ? <PreferencesTitlebarWin /> : <PreferencesTitlebarMac />}
			<div className="flex-1 flex min-h-0">
				{/* Left sidebar */}
				<div className="w-[255px] border-r border-[var(--border)] bg-white shrink-0 pl-6 pr-2 py-2 space-y-1 flex flex-col">
					{TABS.map((tab) => (
						<Button
							key={tab.id}
							variant={activeTab === tab.id ? 'secondary' : 'ghost'}
							size="sm"
							className={cn(
								'w-full justify-start gap-3 py-5 rounded-lg',
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
				<div className="flex-1 flex flex-col min-w-0">
					<div className="flex-1 flex justify-center p-6 overflow-y-auto">
						<div className="w-full max-w-[600px]">
							{activeTab === 'personalize' && (
								<PersonalizeSection settings={settings} updateSettings={updateSettings} />
							)}
							{activeTab === 'format' && (
								<FormatSection settings={settings} updateSettings={updateSettings} />
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
