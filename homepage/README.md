# Flowix Homepage

Flowix 官方落地页 —— **使用笔记管理 AI 工作**。

单文件，无构建步骤，无依赖，无外部资源。

## 本地预览

```bash
# macOS
open index.html

# Linux
xdg-open index.html

# Windows
start index.html
```

或者起本地服务（避免 `file://` 的偶发怪行为）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 部署

把 `index.html` 丢到任何静态托管即可：**GitHub Pages**、**Netlify**、**Vercel**、**Cloudflare Pages**、**Surge**、Nginx 都能跑。

## 文件

- `index.html` — 整页（HTML + 内联 CSS，无 JavaScript 框架）
- `theme-light.jpg` / `theme-dark.jpg` / `theme-rock.jpg` — 三个主题预览截图（从仓库根 `public/` 复制而来，更新主题时重新覆盖即可）
- `README.md` — 本文件

## 设计意图

- **v1 只做中文**——双语会翻倍内容维护成本，先把一种语言打磨到极致；英文版归档在 git 历史里。
- **无框架、无构建**——和"极简"的产品定位同向；审计成本低（单文件、~400 行）。
- **系统字体栈**——`-apple-system` / `PingFang SC` / `Microsoft YaHei` 等系统字体优先，不加载 webfont。
- **两个 CTA**——主推 GitHub（v0.1.0 还没真二进制，"Download" 按钮会撒谎）；次推「从源码构建」跳到锚点。
- **slogan 重排页面**——「用 Markdown 管理 AI 工作」将 AI 段提前到第 3 屏，AI 不再是四项功能之一，而是核心。
- **主题预览可交互**——三个主题通过文字 tab 切换（无 JS 框架、~30 行原生 JS），默认浅色；图片用 `hidden` 属性隐藏非活动项，键盘左右箭头也能切。
- **首屏节奏**——hero 底部 padding 压到 2rem（其它 section 4rem），让预览图在桌面端首屏底部约 1/3 自然露出；预览段不留标题标签，靠 tabs 自解释。
- **1200 主宽 + 720 文本**——`.container` 1200px 给视觉段（预览图、AI 卡片网格 4 列横排）做容器，`.prose` 收口到 720px 左对齐，避免 1200 容器里正文行宽过大。`.container-wide` 与 `.container` 同宽（保留作为未来差异化扩展位）。
- **对齐 light 主题**——颜色 token 全部走 OKLCH，与 [app/flowix-web/css/theme/light.css](../app/flowix-web/css/theme/light.css) 同源：品牌紫 `--brand: oklch(0.552 0.185 273)`、链接紫 `--link: oklch(0.45 0.18 273)`、中性冷蓝灰 `hue 255`。主按钮从黑底换成紫底，让首页"和 app 是同一套皮肤"。

## 下一版 TODO

- [ ] 加暗色模式（对齐 app 的 `light` / `dark` / `rock` 主题）
- [ ] 加英文版本 + 中英切换
- [ ] 加 OG / Twitter 分享卡图片
- [ ] 放一张 30 秒的 demo GIF 或 app 截图
- [ ] 等二进制发布后，主 CTA 换成 "Download for macOS / Windows" 跳到 Releases 页
- [ ] 加「最近更新」或「changelog」段
- [ ] 评估是否拆 "AI 真的会干活" 和 "四件它能做的事" 为两个独立 section（目前相邻但用 eyebrow 区分）
