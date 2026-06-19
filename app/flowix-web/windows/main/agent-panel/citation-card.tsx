import { Quote, X } from "lucide-react";

// 单行引用卡片：用于 inputbox 顶部（待发送预览，可关闭）和 user message
// bubble 顶部（消息回放，只读）。extraClassName 给调用方按上下文补 margin 等。
const BASE_CLASS =
	"flex items-center gap-1 w-full min-w-0 py-1.5 px-2.5 rounded-lg " +
	"bg-[var(--card)] text-[var(--agent-foreground)]";

const ICON_CLASS =
	"w-[0.6875rem] h-[0.6875rem] shrink-0 text-[var(--muted-foreground)] opacity-70";

const TEXT_CLASS =
	"flex-1 min-w-0 text-xs leading-snug text-[var(--muted-foreground)] truncate";

const CLOSE_BTN_CLASS =
	"inline-flex items-center justify-center shrink-0 w-[1.125rem] h-[1.125rem] p-0 " +
	"bg-transparent border-0 rounded text-[var(--muted-foreground)] cursor-pointer " +
	"transition-colors duration-150 hover:bg-[var(--muted)] hover:text-[var(--agent-foreground)]";

interface CitationCardProps {
	text: string;
	onDismiss?: () => void;
	extraClassName?: string;
}

export function CitationCard({ text, onDismiss, extraClassName = "" }: CitationCardProps) {
	return (
		<div className={`${BASE_CLASS} ${extraClassName}`} title={text}>
			<Quote className={ICON_CLASS} />
			<span className={TEXT_CLASS}>{text}</span>
			{onDismiss && (
				<button
					type="button"
					aria-label="移除引用"
					className={CLOSE_BTN_CLASS}
					onClick={onDismiss}
				>
					<X className="w-3 h-3" />
				</button>
			)}
		</div>
	);
}
