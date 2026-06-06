import React, { useState } from "react";
import { MessageCirclePlus, Sparkles, Scroll, FileText, Check } from "lucide-react";
import { clsx } from "clsx";

interface InputboxAddItem {
	id: string;
	label?: string;
	icon: React.ReactNode;
	onClick?: () => void;
	isHeader?: boolean;
	children?: React.ReactNode;
}

interface InputboxAddProps {
	items?: InputboxAddItem[];
	onNewChat?: () => void;
	onAgentChange?: (agent: string) => void;
	onContextFileChange?: (enabled: boolean) => void;
	defaultContextFileEnabled?: boolean;
}

export function InputboxAdd({ items, onNewChat, onAgentChange, onContextFileChange, defaultContextFileEnabled = true }: InputboxAddProps) {
	const [selectedAgent, setSelectedAgent] = useState("default");
	const [contextFileEnabled, setContextFileEnabled] = useState(defaultContextFileEnabled);

	const agentOptions = [
		{ id: "default", label: "默认" },
		{ id: "analysis", label: "分析模式" },
		{ id: "generation", label: "生成模式" },
	];

	const handleContextFileToggle = () => {
		const newValue = !contextFileEnabled;
		setContextFileEnabled(newValue);
		if (onContextFileChange) {
			onContextFileChange(newValue);
		}
	};

	const defaultItems: InputboxAddItem[] = [
		{
			id: "new-chat",
			label: "New Chat",
			icon: <MessageCirclePlus className="h-4 w-4" />,
			onClick: () => {
				if (onNewChat) {
					onNewChat();
				}
			},
		},
		{
			id: "agents",
			icon: <Sparkles className="h-4 w-4" />,
			children: (
				<div className="mt-1">
					<div className="flex items-center gap-1.5 text-xs font-medium text-[var(--muted-foreground)] mb-2 px-1">

					</div>
					<div className="p-2 rounded-lg border border-[var(--border)] bg-[var(--card)]">
						<div className="space-y-0.5">
							{agentOptions.map((option) => (
								<button
									key={option.id}
									type="button"
									onClick={() => {
										setSelectedAgent(option.id);
										if (onAgentChange) {
											onAgentChange(option.id);
										}
									}}
									className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-sm text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors"
								>
									<span>{option.label}</span>
									{selectedAgent === option.id && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
								</button>
							))}
						</div>
					</div>
				</div>
			),
		},
		{
			id: "context-file",
			icon: <FileText className="h-4 w-4" />,
			children: (
				<div className="mt-1">
					<button
						type="button"
						onClick={handleContextFileToggle}
						className="w-full flex items-center justify-between px-1 py-1.5 rounded-md text-sm text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors"
					>
						<div className="flex items-center gap-2">
							<span>基于当前文件</span>
						</div>
						<div
							className={clsx(
								"w-4 h-4 rounded border flex items-center justify-center transition-colors",
								contextFileEnabled
									? "bg-[var(--primary)] border-[var(--primary)]"
									: "border-[var(--muted-foreground)]"
							)}
						>
							{contextFileEnabled && <Check className="h-3 w-3 text-white" />}
						</div>
					</button>
				</div>
			),
		},
		{
			id: "instructions",
			label: "Instructions",
			icon: <Scroll className="h-4 w-4" />,
			onClick: () => {},
		},
	];

	const displayItems = items || defaultItems;

	return (
		<div className="space-y-1">
			{displayItems.map((item) => (
				<div key={item.id}>
					{item.children ? (
						<div className="px-1 py-1.5">
							<div className="flex items-center gap-2 text-sm text-[var(--foreground)] mb-1">
								<span className="text-[var(--muted-foreground)]">{item.icon}</span>
								<span>{item.label || ""}</span>
							</div>
							{item.children}
						</div>
					) : (
						<button
							type="button"
							onClick={() => item.onClick?.()}
							className="w-full flex items-center gap-2 px-1 py-1.5 rounded-md text-sm text-[var(--foreground)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] transition-colors"
						>
							<span className="text-[var(--muted-foreground)]">{item.icon}</span>
							<span>{item.label}</span>
						</button>
					)}
				</div>
			))}
		</div>
	);
}