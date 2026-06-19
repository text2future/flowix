import { useEffect, useState } from "react";
import {
	AlertCircle,
	Check,
	ChevronRight,
	Folder,
	FolderLock,
	Plus,
	Scroll,
	Trash2,
	Wand2,
} from "lucide-react";
import { clsx } from "clsx";
import { pinyin } from "pinyin-pro";
import { toast } from "sonner";
import { useMemoStore, useAgentAccessStore } from "../../../lib/store";
import type { AgentAccessEntry } from "../../../lib/types/agent-access";

// 与 status-bar/notebook-switcher.tsx / status-bar/notebook-switcher 保持一致
// 的字母提取: ASCII 取首字符, CJK 走 pinyin-pro 取首字母。
function getNotebookLetter(name: string | undefined | null, fallback: string = "N"): string {
	if (!name) return fallback;
	const trimmed = name.trim();
	if (!trimmed) return fallback;
	const first = trimmed.charAt(0);
	if (/[A-Za-z0-9]/.test(first)) {
		return first.toUpperCase();
	}
	const py = pinyin(trimmed, { pattern: "first" }).trim();
	if (!py) return fallback;
	return py.charAt(0).toUpperCase();
}

export function InputboxAdd() {
	// 列表 + 勾选 + 加删都从 agent_access store 走, notebook store 只为
	// "is_default" 徽章提供信息 ── access config 不复读 is_default。
	const { config, isLoading, toggle, addFolderFromPicker, removeFolder } = useAgentAccessStore();
	const { notebooks, loadNotebooks } = useMemoStore();
	// 二级面板开关 ── 与 document-titlebar-shared 的 VersionHistorySubmenu
	// 同款: 父级 <div className="relative"> 直接挂 onMouseEnter / onMouseLeave,
	// 子面板 absolute 定位为 trigger 的 DOM 子节点, 鼠标从 trigger 进入子面板
	// 不会触发父级 mouseleave, 不再需要 setTimeout 延迟 / createPortal /
	// stopImmediatePropagation。
	const [submenuOpen, setSubmenuOpen] = useState(false);

	// 打开二级面板时, 如果 store 还没拉过 notebook 就补一次 ── 用来拿
	// is_default 徽章, 跟 access config 互不耦合。
	useEffect(() => {
		if (!submenuOpen) return;
		if (notebooks.length === 0) {
			loadNotebooks().catch(() => {});
		}
	}, [submenuOpen, notebooks.length, loadNotebooks]);

	const handleToggleRow = (entry: AgentAccessEntry) => {
		// 行的点击行为 (vs 勾选框) 是 toggle enabled ── notebook / folder
		// 一视同仁。 之前 notebook 行点 = "切换当前 notebook" (与状态栏
		// notebook-switcher 同款) 已经被本需求覆盖: 用户在弹窗里更想
		// 关心"AI 看得到哪些", 而不是"我现在在编辑哪个"。
		void toggle(entry.id);
	};

	const handleAddFolder = async () => {
		const result = await addFolderFromPicker();
		if (!result.ok && result.reason !== "未选择目录") {
			toast.error(result.reason);
		}
	};

	const handleRemoveFolder = async (id: string) => {
		await removeFolder(id);
	};

	return (
		<div className="space-y-0.5 py-0.5">
			{/* 文件权限 ── 与 document-titlebar-shared 的 VersionHistorySubmenu
			    完全同构: relative 包装 + onMouseEnter(on) / onMouseLeave(off) +
			    按钮 onFocus(on) (键盘可达性)。 二级面板作为 absolute 子节点
			    `right-full top-0 z-[1001]`, 在父级 DropdownMenuContent 的
			    portal 内, 父级 outside-click listener 不会误判关闭。 */}
			<div
				className="relative"
				onMouseEnter={() => setSubmenuOpen(true)}
				onMouseLeave={() => setSubmenuOpen(false)}
			>
				<button
					type="button"
					onFocus={() => setSubmenuOpen(true)}
					className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-sm text-[var(--agent-foreground)] hover:bg-[var(--accent)] hover:text-[var(--secondary-foreground)] transition-colors"
				>
					<span className="flex items-center gap-2">
						<FolderLock className="h-4 w-4 text-[var(--muted-foreground)]" />
						<span>可访问文件</span>
					</span>
					<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
				</button>

				{submenuOpen && (
					// 与 `VersionHistorySubmenu` 同思路但镜像: 一级面板在 + 按钮
					// 上方 (`side="top"`) 展开, trigger 是第一行 ── `bottom-0` 让
					// 子菜单底对齐 trigger 底, 向上延展进 chat area, 避开 + 按钮
					// 与输入框。 `max-h-[400px] overflow-y-auto` 兜底, 窗口很矮
					// 时子菜单内部滚动而不是冲出视口。
					<div
						role="menu"
						className="absolute right-full bottom-0 z-[1001] w-[260px] max-h-[400px] overflow-y-auto bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg px-1 py-1.5 animate-in fade-in-0 zoom-in-95"
					>
						{(() => {
							// 按 kind 分组 ── notebook 在前, folder 在后。 用户视觉
							// 习惯: 笔记本是"自带"的东西, 自定义 folder 是"额外加的",
							// 顺序与"加文件夹"按钮的语义一致。 空组不渲染标题, 避免
							// 出现孤零零的"自定义文件夹"+"暂无"组合。
							const notebookEntries = config.entries.filter((e) => e.kind === "notebook");
							const folderEntries = config.entries.filter((e) => e.kind === "folder");
							const isEmpty = notebookEntries.length === 0 && folderEntries.length === 0;

							if (isEmpty) {
								return (
									<div className="px-2 py-3 text-xs text-center text-[var(--muted-foreground)]">
										{isLoading ? "加载中…" : "暂无访问目录, 点击下方添加"}
									</div>
								);
							}

							const renderEntry = (entry: typeof config.entries[number]) => {
								const isNotebook = entry.kind === "notebook";
								const nb = isNotebook ? notebooks.find((n) => n.id === entry.id) : null;
								const isDefault = !!nb?.isDefault;
								const rowDisabled = entry.missing;
								return (
									<div
										key={entry.id}
										className={clsx(
											"group relative flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors",
											rowDisabled
												? "opacity-60"
												: "hover:bg-[var(--accent)] cursor-pointer",
										)}
										onClick={() => {
											if (rowDisabled) return;
											// 整行点击 = toggle。 勾选框点击是独立列,
											// e.stopPropagation 阻止冒泡到这里 ── 用户
											// 在勾选框区域"点哪生效哪"是预期行为。
											handleToggleRow(entry);
										}}
										title={entry.missing ? "目录不存在, 放回原位后自动恢复" : entry.path}
										role={isNotebook ? "menuitem" : undefined}
									>
										{/* 头像: notebook 用首字母, folder 用文件夹图标 */}
										<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]">
											{isNotebook ? (
												getNotebookLetter(entry.name)
											) : (
												<Folder className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
											)}
										</span>

										{/* 名字 + 失联指示 + 默认徽章 ── folder 只显 entry.name,
										    路径在 `title` 里给 hover tooltip 用, 不再在 item 中 */}
										<span className="flex-1 min-w-0 flex items-center gap-1.5">
											<span className="truncate text-sm text-[var(--agent-foreground)]">
												{entry.name}
											</span>
											{entry.missing && (
												<AlertCircle
													className="h-3 w-3 text-[var(--warning)] shrink-0"
													aria-label="目录不存在"
												/>
											)}
											{isDefault && (
												<span className="shrink-0 inline-flex items-center leading-none h-5 rounded-lg px-1.5 text-[10px] bg-[var(--accent)] text-[var(--primary)]">
													默认
												</span>
											)}
										</span>

										{/* 删除按钮 (仅 folder, hover 时出现) ── 放在勾选框左侧
										    让勾选保持最右一致, 删除的"破坏性"动作稍微远一点 */}
										{!isNotebook && (
											<button
												type="button"
												aria-label="删除该文件夹"
												onClick={(e) => {
													e.stopPropagation();
													void handleRemoveFolder(entry.id);
												}}
												className="shrink-0 p-1 rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
											>
												<Trash2 className="h-3.5 w-3.5" />
											</button>
										)}

										{/* 勾选框 ── 自绘, 跟原"基于当前文件"那种风格保持一致 */}
										<button
											type="button"
											role="checkbox"
											aria-checked={entry.enabled}
											aria-label={entry.enabled ? "取消 AI 访问" : "允许 AI 访问"}
											disabled={rowDisabled}
											onClick={(e) => {
												e.stopPropagation();
												void toggle(entry.id);
											}}
											className={clsx(
												"shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors",
												entry.enabled
													? "bg-[var(--primary)] border-[var(--primary)]"
													: "border-[var(--muted-foreground)]",
												rowDisabled && "cursor-not-allowed",
											)}
										>
											{entry.enabled && (
												<Check className="h-3 w-3 text-[var(--primary-foreground)]" />
											)}
										</button>
									</div>
								);
							};

							// 组标题 ── 跟「更多」下拉弹窗里的 `DropdownMenuLabel` 风
							// 格保持一致, 用 muted-foreground + 11px + tracking-wider。
							const SectionLabel = ({ children }: { children: React.ReactNode }) => (
								<div className="px-2 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
									{children}
								</div>
							);

							// 组间分割线 ── 跟 document-titlebar-shared.tsx 里的
							// `<hr className="mx-2 border-t border-[var(--border)] opacity-50" />`
							// 同款, 不要 `border-b` 那种全宽细线。
							const Divider = () => (
								<hr className="mx-2 my-1 border-t border-[var(--border)] opacity-50" />
							);

							return (
								<>
									{notebookEntries.length > 0 && (
										<>
											<SectionLabel>笔记本</SectionLabel>
											{notebookEntries.map(renderEntry)}
										</>
									)}
									{notebookEntries.length > 0 && folderEntries.length > 0 && <Divider />}
									{folderEntries.length > 0 && (
										<>
											<SectionLabel>自定义文件夹</SectionLabel>
											{folderEntries.map(renderEntry)}
										</>
									)}
								</>
							);
						})()}

						{/* footer: 添加资料夹 ── 跟 chat-history.tsx 里的「新建对话」同款:
						    `border border-[var(--border)]` + `rounded-md` + `w-full`。
						    这里没 `mt-1` ── 上面 `Divider` 已经给了 4px my-1, 视觉
						    间距等同。 */}
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								void handleAddFolder();
							}}
							className="mt-1 flex items-center justify-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-[var(--agent-foreground)] border border-[var(--border)] hover:bg-[var(--muted)] transition-colors"
						>
							<Plus className="h-3.5 w-3.5" />
							<span>添加资料夹</span>
						</button>
					</div>
				)}
			</div>

			{/* 技能 — 占位, 后续接入时再挂 onClick */}
			<button
				type="button"
				className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-[var(--agent-foreground)] hover:bg-[var(--accent)] hover:text-[var(--secondary-foreground)] transition-colors"
			>
				<Wand2 className="h-4 w-4 text-[var(--muted-foreground)]" />
				<span>技能</span>
			</button>

			{/* 指令 — 占位, 后续接入时再挂 onClick */}
			<button
				type="button"
				className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-[var(--agent-foreground)] hover:bg-[var(--accent)] hover:text-[var(--secondary-foreground)] transition-colors"
			>
				<Scroll className="h-4 w-4 text-[var(--muted-foreground)]" />
				<span>指令</span>
			</button>
		</div>
	);
}
