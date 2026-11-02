/**
 * 集合外壳的文案分片（文件夹入口与集合文件入口共用）。
 *
 * 主表 `messages.*` 行数冻结，集合外壳（大标题 / tab 条 / AI 输入框 / 各 tab 面板）
 * 的文案放这里，新增文案不再撑大主表。
 */
const zhCN = {
  // 顶部 agent composer
  "collection.composerPlaceholder": "询问内容…",
  "collection.composerSend": "发送给 {name}",
  "collection.composerAdd": "添加附件",
  "collection.agentSwitch": "切换",
  // tab 条：文件树（仅文件夹类型的集合，且 .index.yaml 的 file_tree 为真）→ 表格视图 → 图墙 / 列表
  "collection.filesTab": "文件夹",
  "collection.emptyFiles": "此集合是空的",
  "collection.noteView": "表格",
  // 资料视图口径：笔记视图（表格/画廊/日历/看板…）建在表格数据上；
  // 资料视图是数据域 tab——「图墙」（媒体域，收图片/视频）与「列表」（其余文件）。
  "collection.mediaView": "图墙",
  "collection.workView": "列表",
  /** tab 条本身的无障碍名称（nav 标签）。 */
  "collection.tabsLabel": "集合视图",
  "collection.viewScope.label": "当前视图类型",
  "collection.viewScope.notes": "仅笔记",
  "collection.viewScope.assets": "仅资料",
  "collection.addView": "新增视图",
  "collection.addDomain": "添加数据域",
  "collection.viewType.table": "表格",
  "collection.viewType.kanban": "看板",
  "collection.viewType.calendar": "日历",
  "collection.viewType.gallery": "画廊",
  "collection.viewType.waterfall": "瀑布流",
  "collection.openFailed": "打开失败",
  "collection.openFolder": "打开文件夹 {name}",
  // 大标题：双击改名（改文件夹名 / 改集合文件名）
  "collection.nameInputLabel": "集合名称",
  "collection.renameName": "重命名集合",
  "collection.renameHint": "双击重命名",
  // 大标题下方的副标题：单行输入框随内容增高，落集合属性 subtitle
  "collection.subtitleInputLabel": "集合副标题",
  "collection.subtitlePlaceholder": "添加描述...",
  // 顶部头图：默认图墙（媒体域）第一张图；悬浮「切换图片」从文件夹内选一张；「···」菜单可隐藏
  "collection.banner.switch": "切换图片",
  "collection.banner.selectFromFolder": "内部选择",
  "collection.banner.onlineGallery": "在线图库",
  "collection.banner.upload": "上传",
  "collection.banner.uploading": "正在上传…",
  "collection.banner.imageOnly": "只能选择图片文件",
  "collection.banner.uploadFailed": "上传图片失败",
  "collection.banner.empty": "无图片",
  // 集合图标：头图处的图标可点击打开属性图标 picker，写入集合属性 `icon`
  "collection.icon.change": "更换图标",
  "collection.icon.reset": "恢复默认图标",
  "collection.icon.pickerHint": "点击图标库中的图标即可应用",
  // 文件树 tab 标题行：高度 / 文字色 / 图标对齐 与表格表头同款
  "collection.filesTab.fileColumn": "名称",
  "collection.filesTab.updatedColumn": "更新时间",
  "collection.filesTab.sizeColumn": "文档大小",
  // 更新时间口径：今天 / 昨天带相对日，更早用完整日期（日期本身走 Intl）
  "collection.filesTab.updatedToday": "今天 {time}",
  "collection.filesTab.updatedYesterday": "昨天 {time}",
  // 相对口径（图墙 / 画廊卡片）：唯一实现在 lib/collection-updated-time.ts。
  // `collection.time.updated` 是前缀 + 相对区间的整句，两个口径共用同一句式。
  "collection.time.updated": "更新 {time}",
  "collection.time.justNow": "刚刚",
  "collection.time.minutesAgo": "{n}分钟前",
  "collection.time.hoursAgo": "{n}小时前",
  "collection.time.daysAgo": "{n}天前",
  "collection.time.monthsAgo": "{n}个月前",
  "collection.time.yearsAgo": "{n}年前",
  "collection.time.unknown": "更新时间未知",
  // 集合显示开关：tab 条「···」与 Work 列 header「···」共用同一批文案与眼睛图标
  "collection.display.more": "显示设置",
  "collection.display.title": "显示标题",
  "collection.display.banner": "显示头图",
  // 开关按钮的无障碍名称按当前状态给（开 → 隐藏，关 → 显示）
  "collection.display.hideTitle": "隐藏标题",
  "collection.display.hideBanner": "隐藏头图",
  // 「···」菜单的添加视图分组：笔记视图建在表格数据上，资料视图是数据域 tab（图墙 / 列表）
  "collection.menu.addNoteViews": "添加笔记视图",
  "collection.menu.addAssetViews": "添加资料视图",
  "collection.menu.mediaHint": "图/视频",
  // 「···」菜单的其余两步：管理已添加的 tab、从向导回到类型列表
  "collection.menu.manageViews": "管理视图",
  "collection.menu.backToViewTypes": "返回视图类型",
  // 「管理视图」里每一行的动作（宿主 tab 与表格视图共用同一套文案）
  "collection.manage.fixed": "固定",
  "collection.manage.remove": "移除",
  "collection.manage.renameView": "重命名视图：{name}",
  "collection.manage.reorderView": "拖动调整视图顺序：{name}",
  "collection.manage.fixedOrder": "顺序固定：{name}",
  "collection.manage.removeTab": "移除 tab：{name}",
  "collection.manage.deleteView": "删除视图：{name}",
  "collection.manage.deleteDisabled": "此处不可删除视图",
  // 添加视图向导的第二/三步：选日期或单选字段、进字段管理
  "collection.wizard.chooseDateField": "选择日期字段",
  "collection.wizard.chooseSelectField": "选择单选字段",
  "collection.wizard.fieldManager": "字段管理",
  // 看板视图依赖的状态字段（属性 key 固定 status）
  "collection.kanban.statusField": "状态",
  "collection.kanban.createStatusFieldForView": "创建状态字段并设置为当前看板分组",
  "collection.kanban.createStatusFieldAndView": "创建状态字段并建立看板视图",
  "collection.kanban.statusNotSelect": "状态字段不是单选类型，请先修改字段类型或选择其他单选属性",
  "collection.kanban.addSelectHint": "可添加单选属性，作为看板分组",
  // 系统维护的时间字段：可读取、不可拖动修改
  "collection.readOnly": "只读",
  "collection.readOnlySystemTime": "创建时间和更新时间由系统维护，不能通过拖动修改",
  "collection.filter.notes": "笔记筛选",
  "collection.filter.assets": "资料筛选",
  // 文件树 tab 的数据集合按钮：位置固定（= 集合所在文件夹），只有一条只读位置行
  "collection.dataset.location": "数据集合",
  "collection.dataset.manage": "管理数据集",
  // 保存冲突：自动重放一次仍撞车时载入磁盘版（用户需要知道自己看到的已是最新版）
  "collection.save.conflictReloaded": "集合文件再次发生变化，已载入最新版本，请重试",
  // 列表（work_documents）集合文件读盘失败：主表没有对应的友好文案 key，放分片里
  "collection.load.workDocuments": "无法加载列表，请重试",
} as const;

export default zhCN;
