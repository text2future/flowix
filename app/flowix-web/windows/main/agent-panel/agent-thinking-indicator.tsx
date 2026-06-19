// 流式响应等待态: 跳动的圆点 + 文字上的扫光高亮。Tailwind 不生成 keyframes,
// 故 @keyframes agentThinkingDot / agentThinkingShine 留在 index.css。
const DOT_CLASS =
	"w-2 h-2 rounded-full bg-primary animate-[agentThinkingDot_1.6s_ease-in-out_infinite]";
const TEXT_CLASS =
	"relative overflow-hidden text-[0.78rem] font-medium leading-none text-[var(--muted-foreground)] " +
	// 扫光高亮 ::after: 渐变 5 段 + 模糊, skew 让光带倾斜更有"流过"的方向感
	"after:content-[''] after:absolute after:-top-[40%] after:-bottom-[40%] after:left-[-60%] " +
	"after:w-[60%] after:[background:linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.22)_30%,rgba(255,255,255,0.78)_50%,rgba(255,255,255,0.22)_70%,transparent_100%)] " +
	"after:[filter:blur(2.5px)] after:skew-x-[-18deg] after:animate-[agentThinkingShine_2.2s_ease-in-out_infinite]";

export function AgentThinkingIndicator() {
	return (
		<div className="px-6 py-1">
			<div className="inline-flex items-center gap-2">
				<span aria-hidden="true" className={DOT_CLASS} />
				<span className={TEXT_CLASS}>思考中</span>
			</div>
		</div>
	);
}
