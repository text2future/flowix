import { isValidElement, lazy, memo, Suspense } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { openNoteByDeepLink } from "@platform/open-target";

// react-syntax-highlighter 体积 ~250KB+ (Light 版本 + 主题 css), 主 chunk 引
// 入会拖慢首屏 (chat panel / 文档 agent 消息都可能触发)。 改用 React.lazy
// 切到独立 chunk, 用户点了"打开对话"或收到第一条带代码块的消息时才按需
// 加载。 静态导入同包里的 `github` theme 也搬过来, 避免 chunk 切分不彻底。
const CodeBlock = lazy(async () => {
  const [{ Light: SyntaxHighlighter }, { github }] = await Promise.all([
    import("react-syntax-highlighter"),
    import("react-syntax-highlighter/dist/esm/styles/hljs"),
  ]);
  return {
    default: ({ language, children }: { language: string; children: string }) => (
      <SyntaxHighlighter
        style={github}
        language={language || "text"}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: "0.5rem 0.75rem 0.75rem",
          background: "var(--editor-block-bg)",
          borderRadius: "0.5rem",
          border: "1px solid var(--border)",
          fontSize: "0.78rem",
          lineHeight: "1.7",
          fontWeight: 400,
          fontFamily: "var(--font-sans)",
        }}
        showLineNumbers={false}
        lineNumberStyle={{
          color: "var(--muted-foreground)",
          paddingRight: "0.75rem",
          minWidth: "2em",
          userSelect: "none",
        }}
      >
        {children.replace(/\n$/, "")}
      </SyntaxHighlighter>
    ),
  };
});

interface MarkdownRendererProps {
  content: string;
}

// Agent 消息 Markdown 元素样式: 与中间 Tiptap 编辑器 (.markdown-editor .tiptap)
// 的常见格式处理对齐 — 标题/strong/em/列表/引用/代码/表格/分割线/标记
// 各自的字体粗细、颜色、间距、边框、圆角都参照 editor.css 的写法。
//
// 字号按右栏窄宽缩到合理区间 (h1=1rem, h4=0.85rem, p=0.82rem 保持不动),
// --agent-foreground (66% 透明) 是 Agent 面板文字的固定透明度, 不动。
const WRAPPER_CLASS =
  "break-words [&>*:first-child]:mt-0 " +
  // 标题: 600 字重 + 行高 1.3 (与 tiptap h1-h6 一致); h1 加 brand 色
  // + 下边线, 跟 tiptap h1 的 padding-bottom / color: var(--brand) 视觉等价。
  "[&_h1]:text-[1rem] [&_h1]:font-semibold [&_h1]:leading-[1.3] [&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:pb-1 [&_h1]:text-[var(--brand)] [&_h1]:border-b [&_h1]:border-border " +
  "[&_h2]:text-[0.95rem] [&_h2]:font-semibold [&_h2]:leading-[1.3] [&_h2]:mt-2.5 [&_h2]:mb-1 " +
  "[&_h3]:text-[0.9rem] [&_h3]:font-semibold [&_h3]:leading-[1.3] [&_h3]:mt-2 [&_h3]:mb-1 " +
  "[&_h4]:text-[0.85rem] [&_h4]:font-semibold [&_h4]:leading-[1.3] [&_h4]:mt-2 [&_h4]:mb-0.5 " +
  // 段落: 字号不动, 行高向 tiptap 靠 (1.6), 段间用半行 box 当节奏
  "[&_p]:text-[0.82rem] [&_p]:leading-[1.7] [&_p]:mt-0 [&_p]:mb-2 [&_p:last-child]:mb-0 " +
  // 列表: list-outside + pl-5 (与 tiptap ul/ol padding-left: 1.5rem 同源),
  // 不用 list-inside, 否则 marker 跟文字挤在一起。marker 走 brand 色
  // (与 tiptap ul/ol li::marker color: var(--brand) 一致)。
  "[&_ul]:list-disc [&_ul]:list-outside [&_ul]:my-2 [&_ul]:pl-5 [&_ul]:text-[0.82rem] [&_ul]:leading-[1.7] " +
  "[&_ol]:list-decimal [&_ol]:list-outside [&_ol]:my-2 [&_ol]:pl-5 [&_ol]:text-[0.82rem] [&_ol]:leading-[1.7] " +
  "[&_li]:my-1 [&_li_li]:my-0.5 [&_li_p]:my-0 " +
  "[&_ul_li]:marker:text-[var(--brand)] [&_ol_li]:marker:text-[var(--brand)] " +
  // 行内强调: strong 700 (与 tiptap strong font-weight: 700 一致);
  // em italic + 300 字重 (与 tiptap em font-style: italic; font-weight: 300 一致)。
  "[&_strong]:font-bold " +
  "[&_em]:italic [&_em]:font-light " +
  // 链接: 颜色走 --document-link (与 tiptap a 同源), hover 用 color-mix
  // 派生白 20% 提亮 (与 tiptap a:hover color-mix(--document-link, white 20%) 一致)。
  "[&_a]:text-[var(--document-link)] [&_a]:no-underline hover:[&_a]:underline hover:[&_a]:[color:color-mix(in_oklch,var(--document-link),white_20%)] " +
  // 引用块: 3px --border 左边线 (与 tiptap blockquote border-left: 0.1875rem solid #ddd 视觉等价;
  // 用 --border token 在三主题下自动适配, 不硬编码 #ddd)。italic + muted-foreground 跟 tiptap 同源。
  "[&_blockquote]:border-l-[3px] [&_blockquote]:border-l-[var(--border)] [&_blockquote]:pl-3 [&_blockquote]:my-2 [&_blockquote]:italic [&_blockquote]:text-[var(--muted-foreground)] " +
  // 分割线: 走 --divider token (与 tiptap hr border-top: 0.0625rem solid var(--divider) 同源)
  "[&_hr]:border-0 [&_hr]:my-3 [&_hr]:border-t [&_hr]:border-t-[var(--divider)] " +
  // 内联 code: 视觉对齐 .markdown-editor .tiptap p code 的口径 —
  // padding: 0 0.4rem / border-radius: 0.4rem / font-size: 0.78rem /
  // background: var(--code-bg) / color: var(--foreground) / font-family: inherit. 跨三处
  // (Tiptap 正文 / AgentThreadCard 卡片 / 右栏 Agent 消息体) 走同一套 token. 块 code 仍
  // 走 --editor-block-bg + 0.5rem 圆角区分视觉权重.
  "[&_code]:bg-[var(--code-bg)] [&_code]:px-[0.4rem] [&_code]:py-0 [&_code]:rounded-[0.4rem] [&_code]:border [&_code]:border-border [&_code]:text-[0.78rem] [&_code]:text-foreground [&_code]:font-sans " +
  // pre 内的 code 还原: 透明背景, 无边框, 字号回到 pre 字号, color 走 muted-foreground
  // (与 tiptap pre code 行为一致: padding: 0, 走父级 pre 背景)
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:border-0 [&_pre_code]:text-[0.78rem] [&_pre_code]:text-[var(--muted-foreground)] [&_pre_code]:font-sans " +
  // 兜底 pre (非代码块场景): 行高 + overflow-x 与原行为一致
  "[&_pre]:m-0 [&_pre]:text-[0.86rem] [&_pre]:leading-[1.7] [&_pre]:overflow-x-auto [&_pre]:font-sans " +
  // 标记 / 高亮 (==highlight==): --document-highlight-bg + 微圆角, 跟 tiptap mark 同源
  "[&_mark]:bg-[var(--document-highlight-bg)] [&_mark]:rounded-sm [&_mark]:px-0.5 [&_mark]:text-foreground " +
  // 表格: border-separate + border-spacing: 0 让 rounded 可见; cell 全边框, 首行/首列补回
  // (与 tiptap table border-collapse: separate; border-spacing: 0; border-radius: 8px 一致)
  "[&_table]:w-full [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:my-2 [&_table]:rounded-lg [&_table]:overflow-hidden [&_table]:border [&_table]:border-border " +
  "[&_thead]:bg-[var(--muted)] " +
  "[&_th]:border [&_th]:border-border [&_th]:border-t-0 [&_th]:border-l-0 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-[0.82rem] [&_th]:text-foreground " +
  "[&_td]:border [&_td]:border-border [&_td]:border-t-0 [&_td]:border-l-0 [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-[0.82rem] [&_td]:text-foreground " +
  "[&_tr:first-child>th]:border-t [&_tr:first-child>td]:border-t " +
  "[&_th:first-child]:border-l [&_td:first-child]:border-l ";

const CODE_BLOCK_CLASS = "relative my-3 rounded-lg overflow-hidden border border-border";
// 表格 wrapper: 仅承担水平滚动 (overflow-x-auto) + 外间距, 不再额外加
// 边框/圆角 — 表格自己 border + rounded-lg + overflow-hidden 已经把外观
// 收口, 套两层会出现"双边框 + 圆角错位"。
const TABLE_WRAPPER_CLASS = "overflow-x-auto my-3 bg-transparent";

// Layer 1: components / urlTransform / onClick handler 都提到 module 顶层
// 常量 ── 否则每次 render 都是 inline 新对象, 顶层 React.memo 拿到的
// content 即便相同, 内部 ReactMarkdown 也会因 components 引用变化重新
// 走它内部的 reconcile (这一层不是 memo 决定的, 但提到顶层有零成本).
//
// 真正决定 memo 是否生效的是 `MarkdownRenderer` 自身的 props 比较 ── 只比
// `content`. WRAPPER_CLASS 等已是常量, content 不变 → memo 跳过.

const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, ...props }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
  pre({ children }) {
    // react-markdown v10 仍会为围栏代码块包一层默认 <pre>。
    // 我们在下面的 `code` 覆盖里已经返回了 <div class="code-block">，
    // 把它再套进 <pre> 会形成两套盒模型叠加（外层 <pre> 的
    // font-size / line-height / overflow-x: auto 与 SyntaxHighlighter
    // 的 customStyle 重复），导致代码块视觉上出现「重影 / 双边框」。
    // 因此当 <pre> 的子节点是 code-block 容器时，直接透传 children。
    const child = Array.isArray(children) ? children[0] : children;
    if (
      isValidElement(child) &&
      child.type === "div" &&
      (child.props as { className?: string })?.className === CODE_BLOCK_CLASS
    ) {
      return <>{child}</>;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const isInline = !match;
    const language = match ? match[1] : "";

    if (isInline) {
      return <code {...props}>{children}</code>;
    }

    return (
      <div className={CODE_BLOCK_CLASS}>
        {/* 懒加载: 250KB+ chunk 只在第一个带代码块的消息到达时拉。
            Suspense fallback 走 inline <pre>, 加载完无缝替换 ── 用户
            视觉上不会感知 (chat 流本来就是逐 token 出现)。 */}
        <Suspense
          fallback={
            <pre className="m-0 px-3 py-2 text-[0.78rem] text-[var(--muted-foreground)] font-sans">
              {String(children).replace(/\n$/, "")}
            </pre>
          }
        >
          <CodeBlock language={language}>
            {String(children).replace(/\n$/, "")}
          </CodeBlock>
        </Suspense>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className={TABLE_WRAPPER_CLASS}>
        <table>{children}</table>
      </div>
    );
  },
};

// react-markdown v10 默认 urlTransform 只放行 http/https/mailto/tel,
// `flowix://` 会被清空成 `""`。 透传自定义 scheme 之后,
// 下文自定义的 <a> 才能在点击时拿到完整 href。
const urlTransform = (url: string) => url;

const remarkPlugins = [remarkGfm];

// 委托: 点击 Agent 输出里的 flowix:// 深链时, 走 `openByTarget` 统一管线
// (跟 noteReference 双击 / 单 instance 二次启动 / 外部深链同一入口)。
// 不影响 http(s) 链接 — 那些由 <a> 默认行为走浏览器/OS。
function handleWrapperClick(e: React.MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>(
    'a[href^="flowix://"]'
  );
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const href = a.getAttribute("href");
  if (href) void openNoteByDeepLink(href);
}

function MarkdownRendererInner({ content }: MarkdownRendererProps) {
  return (
    <div className={WRAPPER_CLASS} onClick={handleWrapperClick}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={urlTransform}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Layer 1: 用 React.memo 包裹, 只在 content 变化时重 parse markdown.
// 流式场景下 (chat-store `applyTextChunk` 仅修改 pending assistant 那一条),
// 其它历史消息的 content 引用稳定, 此处直接跳过, 历史 N 条消息零 markdown
// 重 parse 开销.
export const MarkdownRenderer = memo(
  MarkdownRendererInner,
  (prev, next) => prev.content === next.content
);
