/**
 * File-tree rename messages, split out of the frozen main table.
 *
 * The main `messages.*` tables are frozen at a hard line limit; new file-tree
 * copy lives here so adding a message never grows them again.
 */
const zhCN = {
  "memo.fileTree.invalidName": "文件名称格式非法",
  "memo.fileTree.invalidNameReplaced": "文件名称格式非法，已自动替换",
  // 文件树的对话行 / 仓库文档默认在右栏（Browser）打开，行菜单保留回左栏（Work）的入口。
  "memo.fileTree.openInLeft": "在左栏打开",
  // 分区（对话 / 视图 / 仓库）内容为空时的一行空状态：左侧提示 + 右侧「隐藏」。
  "memo.fileTree.sectionEmpty": "列表为空",
  "memo.fileTree.sectionEmptyHide": "隐藏",
  // 规则排除的目录（隐藏文件夹 / 依赖目录）不进笔记索引，在那里新建笔记或视图会立刻从列表里消失。
  "memo.fileTree.contentCreationBlocked": "该文件夹不参与笔记索引，新建的笔记和视图不会出现在列表里",
  // 打开被规则排除的文件夹时，用这行提示替代「如何显示当前文件夹？」选择界面。
  "memo.fileTree.hiddenFolderTitle": "这是一个隐藏文件夹",
  "memo.fileTree.hiddenFolderNoPreview": "无法透视查看其中的内容",
} as const;

export default zhCN;
