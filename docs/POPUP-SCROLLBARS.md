# 弹出列表的滚动规范

下拉框、popover、右键菜单以及 DOM 控制器生成的弹出列表，共用一套滑块状态和外观：默认隐藏，用户滚动或悬停轨道时显示，停滚 700ms 后淡出，拖动期间保持显示。搜索结果更新、选中项定位和内容尺寸变化仅更新几何，不主动显示滑块。

## 实现分工

| 层级 | 职责 |
| --- | --- |
| `shared/lib/scrollbar-controller.ts` | 绑定现有 frame 和 viewport，管理双轴几何、输入、显隐、拖动、观察器及清理；不移动内容节点 |
| `OverlayScrollbar` / `createOverlayScrollbarDom` | React / DOM 的节点与生命周期适配，共用同一控制器 |
| `PopupScrollArea` / `createPopupScrollAreaDom` | 弹出列表的尺寸、圆角避让和滚动方向约定 |
| `SelectContent`、`DropdownMenuContent`、`PopoverContent`、`ContextMenuContent` | 定位、开关、焦点、动画和子菜单归属 |

滑块颜色以 `muted-foreground` 混合透明色：普通 50%、悬停 80%、拖动 80%。颜色、滑块宽度、圆角和淡出过渡来自 `styles/overlay-scrollbar.css` 的变量。显隐延时、输入识别窗口和最小滑块长度来自 `shared/lib/scrollbar-config.ts`。平台差异仅影响通用页面滚动条的几何；弹出列表使用相同的 6px 滑块。

## 组合方式

简单下拉框和右键菜单自动拥有滚动区域。Popover 使用 `scrollable` 开启整体滚动，`fitViewport`、`alignToAnchorOrigin` 默认也开启整体滚动。

带固定搜索栏或底栏的弹窗，显式关闭外壳滚动，在中间放置一个区域：

```tsx
<PopoverContent fitViewport scrollable={false} className="flex min-h-0 flex-col">
  <SearchHeader />
  <PopupScrollArea className="min-h-0 flex-1" scrollerClassName="space-y-1 px-1">
    {items}
  </PopupScrollArea>
  <ActionFooter />
</PopoverContent>
```

`className` 控制 frame 的布局和最大高度；`scrollerClassName` 控制滚动内容的间距。列表的 `role`、`id`、`aria-label` 放在 `scrollerProps`；需要读写 `scrollTop` 时使用 `scrollerRef`。组件 `ref` 暴露 `update` / `getScroller`，外壳 DOM 引用使用 `frameRef`。

`SelectContent`、`DropdownMenuContent` 等外壳的 `className` 用于边框、定位和尺寸，列表间距通过 `scrollerClassName` 传入。避免在外壳另加 `overflow-y-auto`，以免形成第二个滚动区域。较小的业务最大高度会与视口限制取交集。

跨出父菜单的子菜单通过共享 popover 的 portal 渲染，并使用 `keepParentMenuOpen` 声明归属。历史版本菜单已采用此方式，父菜单可以正常滚动。

## DOM 控制器

创建一个 `createPopupScrollAreaDom(document)`，将列表条目渲染到 `scroller`，将 `frame` 挂到弹窗中。替换整片区域或销毁弹窗前调用 `destroy()`。局部更新条目时保持同一个控制器，内容和图片尺寸变化会自动同步；程序定位可调用 `update({ reveal: false, schedule: false })`。

`renderScroller` 用于 cmdk 等拥有自身滚动节点语义的库，保证其 ref、ARIA 属性和选中项滚动仍对应实际 viewport。

## 保留的其他滚动类型

| 场景 | 处理方式 |
| --- | --- |
| 页面、侧栏、编辑器、多维表格 | 使用通用 `OverlayScrollbar`，按各自布局管理可滚动轴 |
| 文本输入框、iframe 内文档 | 保留控件或文档自己的滚动语义，使用其样式适配 |
| 创建文档通知堆叠 | 保留原生滚动和卡片阴影留白，共用颜色与显隐延时 |
| 水平标签条、表格浮动工具栏 | 保留现有隐藏横向滑块的设计，通过滚动手势浏览 |

新增可滚动弹出列表优先使用 `PopupScrollArea`。调整外观时修改公共变量，调整交互时修改共享控制器，避免在业务组件内新增显隐计时器或滑块颜色。

## 验证重点

共享测试覆盖用户与程序滚动、空闲淡出、持续拖动、丢失指针捕获、滚轮单位、溢出边界、异步内容尺寸、iframe 节点归属及销毁。React 适配还覆盖 StrictMode 重挂载、列表语义和回调；菜单测试覆盖选择、焦点及 portal 子菜单归属。
