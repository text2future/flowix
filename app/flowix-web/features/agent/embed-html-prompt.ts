import {
  HTML_EMBED_KINDS,
  HTML_EMBED_PROTOCOL,
  HTML_EMBED_PROTOCOL_VERSION,
} from "@/lib/html-embed-api";

/**
 * Agent-facing pointer to the embedded-page API.
 *
 * This block exists because the bridge was implemented but undiscoverable: no
 * agent prompt mentioned `window.flowix`, so generated dashboards could not use
 * it. It used to restate every kind, param and row field, which meant a second
 * copy of the contract that drifted the moment a field was renamed. The detail
 * now lives in the capability catalog (`flowix html`, generated from
 * `@/lib/html-embed-api`); this block only has to make the agent run it, plus
 * the rules a page cannot work without — the location rule especially, since
 * the bridge takes `notebookId`/`scopePath` from the surface that opened the
 * file and a page outside the notebook directory answers every request E_SCOPE.
 *
 * Kept deliberately short: it is prepended to the first message of every agent
 * session, including agents that cannot use the CLI, so it must still be
 * enough to write a working page on its own.
 */
const KIND_LIST = HTML_EMBED_KINDS
  .map((entry) => (entry.params ? `\`${entry.kind}\`（${entry.params}）` : `\`${entry.kind}\``))
  .join(" / ");

export const FLOWIX_EMBED_HTML_PROMPT_BLOCK = [
  "# 笔记本内 HTML 页面（window.flowix）",
  "在「当前笔记本目录内」创建 .html 文件时，Flowix 预览它会注入数据桥 window.flowix。",
  "文件必须落在当前笔记本目录里；放到目录外会被当作外部文件打开，笔记本相关请求返回 E_SCOPE，product-theme 和 capabilities 仍可用。",
  "",
  "动手前先取一次能力目录 ── 每个 kind 的语义、参数、返回形状、踩坑和预算都在里面：",
  "  flowix html（本地 CLI 的目录可能与运行中的宿主不同；页面可 request('capabilities') 查询当前宿主）",
  "要能直接跑的整页骨架（写进笔记本目录再改；别用 > 重定向，Windows 会把中文按 GBK 落盘）：",
  "  flowix html --template workbench --out board.html     # 零 JS 工作台",
  "  flowix html --template table --out rows.html          # 命令式取行 + 变更后重取",
  "",
  `协议 ${HTML_EMBED_PROTOCOL} v${HTML_EMBED_PROTOCOL_VERSION}：window.flowix.request(kind, params) -> Promise<payload>；`,
  "失败时 error.code 是 E_UNSUPPORTED / E_SCOPE / E_BUSY / E_INVALID / E_TIMEOUT / E_INTERNAL 之一。",
  `kind 只有：${KIND_LIST}。`,
  "零 JS 优先：<meta name=\"flowix-data\" content=\"stats views\"> 让宿主自动拉取，再用 data-fx-text /",
  "attr / style / each / if 绑定；单个 CSS 属性用 data-fx-style（写成 data-fx-attr=\"style:...\" 会写坏整条 style），",
  "嵌套循环用 data-fx-as 改名；自己 request 的页面要在 onInvalidate 里重取。",
  "可拉取的形状：stats{totalMemos,todoMemos,databaseCount,topTags[{name,count,barWidth}]}、",
  "views{collections[{name,type,relativePath,href,rowCount,defaultViewId,views[{id,name}]}]}、theme.tokens{background,foreground,card,brand}。",
  "要能点开：collections[].href 与 rows[].href 是宿主给的 flowix://open 深链，放进 <a href> 就能跳到该集合 / 那篇笔记；",
  "别改写成 file:// 或相对路径（会被当成外部文件，集合与文件夹打不开）。",
  "",
  "授权：用户打开页面即授权页面使用当前笔记本的 API，包括写入；create-note 可直接创建笔记，重试须复用 clientRequestId；页面是不透明源，没有 localStorage / IndexedDB / cookie。",
].join("\n");
