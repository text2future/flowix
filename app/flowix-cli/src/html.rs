//! `flowix html` ── 笔记本内 HTML 页面的能力目录。
//!
//! 这个命令存在的理由：桥早就实现了，但写页面的 Agent 不知道有它，于是生成的
//! 页面全靠手写静态数字。目录必须和契约同源，所以内容不是手写的 ──
//! `scripts/gen-embed-catalog.mjs` 从 `app/flowix-web/lib/html-embed-api.ts`
//! 生成 `resources/embed-catalog.json`，本模块只负责排版（以及 `--template`
//! 打印两个可运行模板）。
//!
//! 手动改 `embed-catalog.json` 会被 `npm run check:embed-catalog` 打回。
//!
//! 两个词的分工别改回去：**命令叫 `html`**（页面作者要写的是笔记本里的 .html
//! 文件），**目录叫 embed-catalog**（它描述的是 `flowix.embed` 协议）。命令名
//! 选名词是想让人在 `--help` 里一眼认出「写页面用这个」；叫 `embed` 会读成动词
//! 「把文件嵌进去」，而这条命令不写任何东西（除了 `--out`）。

use serde::Deserialize;
use std::fmt::Write as _;

use crate::errors::CliError;

const CATALOG: &str = include_str!("../resources/embed-catalog.json");

/// 模板正文编进二进制：CLI 要能在没有安装目录的机器上直接吐出来。
const TEMPLATES: &[(&str, &str)] = &[
    (
        "workbench",
        include_str!("../resources/templates/workbench.html"),
    ),
    ("table", include_str!("../resources/templates/table.html")),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    protocol: String,
    version: u32,
    max_view_rows: u32,
    max_inflight: u32,
    field_types: Vec<String>,
    error_codes: Vec<String>,
    bindings: Vec<String>,
    meta_keys: Vec<String>,
    kinds: Vec<Kind>,
    templates: Vec<Template>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kind {
    kind: String,
    intent: String,
    when_to_use: String,
    summary: String,
    params: Option<String>,
    returns: String,
    #[serde(default)]
    notes: Vec<String>,
}

#[derive(Deserialize)]
struct Template {
    id: String,
    about: String,
}

/// `flowix html [--template <id>] [--out <path>] [--force] [--json]`
pub(crate) fn cmd(
    template: Option<&str>,
    out: Option<&str>,
    force: bool,
    json: bool,
) -> Result<(), CliError> {
    if let Some(id) = template {
        let source = template_source(id)?;
        return match out {
            Some(path) => write_template(path, source, force),
            None => {
                print!("{source}");
                if !source.ends_with('\n') {
                    println!();
                }
                Ok(())
            }
        };
    }
    if out.is_some() {
        return Err(CliError::Usage("--out requires --template <ID>".into()));
    }
    if json {
        // 原样直出：与仓库里的生成物逐字节一致，被脚本 diff 时不会因为重新
        // 序列化而漂移。
        print!("{CATALOG}");
        return Ok(());
    }
    let catalog: Catalog = serde_json::from_str(CATALOG)
        .map_err(|error| CliError::Other(format!("embed catalog is unreadable: {error}")))?;
    print!("{}", render(&catalog));
    Ok(())
}

/**
 * Write the page straight to disk instead of letting the shell redirect.
 *
 * Templates carry Chinese comments, and `flowix html --template x > board.html`
 * on Windows PowerShell 5.1 encodes stdout as the console codepage — the file
 * lands as GBK and the user opens a page of mojibake. The CLI's own notes already
 * tell agents to prefer `--file` over piping for exactly this reason; `--out` is
 * the same fix for this command.
 *
 * `--out` points into a notebook, i.e. at user content: re-running the command
 * to grab a fresh skeleton would otherwise delete the edits made to the last
 * one, so an existing file is refused unless the caller says `--force`.
 */
fn write_template(path: &str, source: &str, force: bool) -> Result<(), CliError> {
    if !force && std::path::Path::new(path).exists() {
        return Err(CliError::Usage(format!(
            "`{path}` already exists; pass --force to overwrite it"
        )));
    }
    std::fs::write(path, source.as_bytes()).map_err(|error| {
        CliError::Io(std::io::Error::new(
            error.kind(),
            format!("failed to write `{path}`: {error}"),
        ))
    })?;
    println!("{path}");
    Ok(())
}

fn template_source(id: &str) -> Result<&'static str, CliError> {
    match TEMPLATES.iter().find(|(name, _)| *name == id) {
        Some((_, source)) => Ok(source),
        None => {
            let available = TEMPLATES
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
                .join(", ");
            Err(CliError::Usage(format!(
                "unknown template `{id}`; available: {available}"
            )))
        }
    }
}

fn render(catalog: &Catalog) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "笔记本内 HTML 页面能力（{} v{}）",
        catalog.protocol, catalog.version
    );
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "页面用 window.flowix.request(kind, params) 取数，返回 Promise<payload>。"
    );
    let _ = writeln!(
        out,
        "失败时 error.code 是 {} 之一。",
        catalog.error_codes.join(" / ")
    );
    let _ = writeln!(
        out,
        "文件须放在目标笔记本目录内；外部页面的笔记本请求返回 E_SCOPE。"
    );

    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "打开页面即授权当前笔记本内的读写能力；请只打开信任的页面。"
    );
    let _ = writeln!(
        out,
        "此目录来自本地 CLI；用 request('capabilities') 查询运行中宿主的实际能力。"
    );
    let _ = writeln!(out, "能力（按搭页面的顺序）：");
    for (index, kind) in catalog.kinds.iter().enumerate() {
        let _ = writeln!(out);
        let _ = writeln!(out, "  {}) {} · {}", index + 1, kind.kind, kind.intent);
        let _ = writeln!(out, "     何时用：{}", kind.when_to_use);
        let _ = writeln!(out, "     说明：{}", kind.summary);
        let _ = match &kind.params {
            Some(params) => writeln!(out, "     参数：{params}"),
            None => writeln!(out, "     参数：无"),
        };
        let _ = writeln!(out, "     返回：{}", kind.returns);
        for note in &kind.notes {
            let _ = writeln!(out, "     · {note}");
        }
    }

    let _ = writeln!(out);
    let _ = writeln!(out, "零 JS 绑定（可选，优先用）：");
    let _ = writeln!(
        out,
        "  <meta name=\"flowix-data\" content=\"{}\"> 让宿主自动拉取（可用键：{}），再用",
        catalog
            .meta_keys
            .iter()
            .take(2)
            .cloned()
            .collect::<Vec<_>>()
            .join(" "),
        catalog.meta_keys.join(" / ")
    );
    let _ = writeln!(
        out,
        "  {} 绑定。",
        catalog
            .bindings
            .iter()
            .map(|binding| format!("data-fx-{binding}"))
            .collect::<Vec<_>>()
            .join(" / ")
    );
    let _ = writeln!(
        out,
        "  · 单个 CSS 属性用 data-fx-style=\"width:item.barWidth\"；data-fx-attr=\"style:...\" 会把整个 style 替换成一个值。"
    );
    let _ = writeln!(
        out,
        "  · 嵌套循环用 data-fx-as=\"view\" 改名，否则内层 item 遮住外层。"
    );
    let _ = writeln!(
        out,
        "  · 自己 request 的页面不写 <meta>；笔记本数据变了要在 onInvalidate 里重取。"
    );

    // 「点一下就跳过去」是页面常用的能力。这两个 href 是宿主编好
    // 的深链；不说清，作者会去拼 file:// 或相对路径，结果被当成外部文件打开。
    let _ = writeln!(out);
    let _ = writeln!(out, "可点跳转：");
    let _ = writeln!(
        out,
        "  collections[].href、rows[].href 是 flowix://open 深链，直接放进 <a href>。"
    );
    let _ = writeln!(
        out,
        "  别改写成 file:// 或相对路径：那会按外部文件打开，集合和文件夹打不开。"
    );

    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "字段类型（fields[].type）：{}",
        catalog.field_types.join(" / ")
    );
    let _ = writeln!(
        out,
        "预算：view-data 单次最多 {} 行；页面同时最多 {} 个在途请求。",
        catalog.max_view_rows, catalog.max_inflight
    );

    if !catalog.templates.is_empty() {
        let _ = writeln!(out);
        let _ = writeln!(
            out,
            "模板（--template <id> 打印源码，加 --out <path> 直接写成 UTF-8 文件）："
        );
        for template in &catalog.templates {
            let _ = writeln!(
                out,
                "  flowix html --template {} --out {}.html",
                template.id, template.id
            );
            let _ = writeln!(out, "      {}", template.about);
        }
    }

    let _ = writeln!(out);
    // 不指向仓库里的 docs/：那份文档不随应用安装，读者手里的机器上根本没有。
    let _ = writeln!(out, "机读目录（脚本 / 工具用）：flowix html --json");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed() -> Catalog {
        serde_json::from_str(CATALOG).expect("embedded catalog parses")
    }

    #[test]
    fn catalog_carries_every_binding_the_sdk_documents() {
        let catalog = parsed();
        // `as` is the nested-loop rename hook; losing it silently breaks any
        // page with two loops.
        assert!(catalog.bindings.contains(&"each".to_string()));
        assert!(catalog.bindings.contains(&"as".to_string()));
    }

    #[test]
    fn text_output_names_every_kind_and_its_params() {
        let catalog = parsed();
        let text = render(&catalog);
        for kind in &catalog.kinds {
            assert!(
                text.contains(&kind.kind),
                "{} missing from output",
                kind.kind
            );
        }
        assert!(
            text.contains("view-data") && text.contains("relativePath"),
            "the params line is what tells an agent what to pass"
        );
        assert!(text.contains(&format!("--template {}", TEMPLATES[0].0)));
    }

    #[test]
    fn text_tells_the_page_how_to_make_what_it_renders_clickable() {
        // Both hrefs come from the host; a page that rebuilds them gets a link
        // the preview resolves as an external file instead of a collection.
        let text = render(&parsed());
        assert!(text.contains("collections[].href") && text.contains("rows[].href"));
        assert!(text.contains("flowix://open"));
    }

    #[test]
    fn every_template_is_reachable_by_id() {
        for (id, source) in TEMPLATES {
            assert!(!source.trim().is_empty(), "{id} is empty");
            assert_eq!(
                template_source(id).expect("known template resolves"),
                *source
            );
        }
        let error = template_source("nope").expect_err("unknown template must fail");
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn out_writes_the_template_as_utf8_and_refuses_to_clobber() {
        let path = std::env::temp_dir().join(format!("flowix-embed-{}.html", std::process::id()));
        let path_text = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);

        cmd(Some("workbench"), Some(&path_text), false, false).expect("template writes");
        let written = std::fs::read(&path).expect("file exists");
        assert_eq!(
            String::from_utf8(written).expect("utf-8 on disk"),
            TEMPLATES[0].1
        );

        // A second run must not eat the edits made to the first one.
        let error = cmd(Some("workbench"), Some(&path_text), false, false)
            .expect_err("existing file needs --force");
        assert!(matches!(error, CliError::Usage(_)));
        cmd(Some("table"), Some(&path_text), true, false).expect("--force overwrites");

        let _ = std::fs::remove_file(&path);

        // `--out` without a template is a mistake, not a silent no-op.
        let error = cmd(None, Some(&path_text), false, false).expect_err("--out needs --template");
        assert!(matches!(error, CliError::Usage(_)));
    }
}
