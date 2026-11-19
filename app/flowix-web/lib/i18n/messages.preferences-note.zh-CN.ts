/**
 * Preferences「笔记」组（模板 / 属性 / 管理和显示）新增文案，从冻结的主表拆出。
 * 侧边栏 tab 叫「其他设置」，页内顶部标题是「笔记管理」；页内依次是
 * 「笔记默认位置」、「笔记索引」说明与「访问空间显示」开关分组。
 */
const zhCN = {
  "preferences.groups.notes": "笔记",
  "preferences.tabs.noteOther": "其他设置",
  "preferences.noteOther.interface": "笔记管理",
  "preferences.noteOther.notebook.title": "笔记本",
  // 行主标题：这条设置管的是「新建笔记默认写到哪」。
  "preferences.noteOther.createLocation.label": "笔记默认位置",
  // 行副标题：点明作用面（笔记列表里的新建动作）。
  "preferences.noteOther.createLocation.description": "笔记列表的新建写入文件夹",
  // 「笔记索引」分组：只有说明没有控件，讲清隐藏文件夹不进索引的后果。
  "preferences.noteOther.indexSection": "笔记索引",
  "preferences.noteOther.indexDescription": "隐藏文件夹不参与索引，即不在笔记列表展示，不可检索，但不影响访问",
  // 「访问空间显示」独立分组的标题，与页首「笔记管理」同一套 SectionHeader 样式。
  "preferences.noteOther.spaceSection": "访问空间显示",
  // 访问空间（文件树）的展示开关，默认打开。
  "preferences.noteOther.spaceHiddenFolders.label": "访问空间显示隐藏文件夹",
  // 行副标题：说明「隐藏文件夹」的判定口径，避免与系统回收站等概念混淆。
  "preferences.noteOther.spaceHiddenFolders.description": "以 . 开头命名的本地文件夹",
  "preferences.noteOther.spaceSystemFolders.label": "访问空间显示系统文件夹",
  "preferences.noteOther.spaceSystemFolders.description": "attachments, node_modules, __pycache__ 等",
  // 文件夹选择浮层的标题，沿用旧短文案。
  "preferences.noteOther.createLocation.pickerTitle": "默认创建位置",
  "preferences.noteOther.rootFolder": "笔记本根目录",
  "preferences.noteOther.expandFolder": "展开文件夹",
  "preferences.noteOther.collapseFolder": "折叠文件夹",
  "preferences.noteOther.saved": "已更新默认创建位置",
  "preferences.noteOther.saveFailed": "保存默认创建位置失败",
  "preferences.noteOther.loadFailed": "加载设置失败，请重试",
  "preferences.noteOther.noNotebooks": "暂无笔记本",
  "preferences.tabs.memory": "记忆",
  "preferences.memory.title": "记忆笔记位置",
  "preferences.memory.description": "使用本地 Agent 或 Flowix AI 时，AI 根据意图将方案、工作流、踩坑或自定义记忆写入以下位置",
  "preferences.memory.columns.scene": "场景 （Use When）",
  "preferences.memory.columns.folder": "场景记忆保存位置",
  "preferences.memory.locations.general": "通用记忆",
  "preferences.memory.locations.solution": "方案",
  "preferences.memory.locations.workflow": "工作流",
  "preferences.memory.locations.name": "位置名称",
  "preferences.memory.locations.namePlaceholder": "位置名称",
  "preferences.memory.locations.path": "存储路径",
  "preferences.memory.locations.notebookPrefix": "笔记本",
  "preferences.memory.locations.pathPlaceholder": "默认写入 Memory/",
  "preferences.memory.locations.solutionPathPlaceholder": "默认写入 Memory/方案/",
  "preferences.memory.locations.workflowPathPlaceholder": "默认写入 Memory/工作流/",
  "preferences.memory.locations.add": "新增记忆场景",
  "preferences.memory.locations.remove": "删除位置",
  "preferences.memory.personality.title": "AI 性格",
  "preferences.memory.personality.placeholder": "输入 AI 性格信息",
  "preferences.memory.guide.title": "使用教程",
  "preferences.memory.guide.lead": "你可以如下对 AI 说：",
  "preferences.memory.guide.plan": "为我保存这份方案",
  "preferences.memory.guide.workflow": "为我记录这个流程",
  "preferences.memory.guide.pitfall": "为我记录这次避坑方案",
} as const;

export default zhCN;
