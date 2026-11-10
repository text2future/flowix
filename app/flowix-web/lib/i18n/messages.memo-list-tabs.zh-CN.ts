/**
 * 侧边栏列表顶部视图相关文案。
 * 视图 tab 是纯图标，hover tooltip 用这里的短文案；
 * 长文案（访问空间 / 全部笔记）保留在主表作 aria 标签。
 */
const zhCN = {
  "memo.list.viewFoldersShort": "空间",
  // 笔记列表顶部下拉按钮无筛选时的标题：笔记视图用短文案「笔记」，
  // 仅文件夹视图兜底场景才落到这里的「全部」。
  "memo.list.viewCardsShort": "笔记",
  "memo.list.headerAll": "全部",
} as const;

export default zhCN;
