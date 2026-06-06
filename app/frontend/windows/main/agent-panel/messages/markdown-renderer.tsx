import { isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import { github } from "react-syntax-highlighter/dist/esm/styles/hljs";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
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
            (child.props as { className?: string })?.className === "code-block"
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
            <div className="code-block">
              <SyntaxHighlighter
                style={github}
                language={language || "text"}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  padding: "0.5rem",
                  background: "var(--agent-bg-code)",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--agent-border)",
                  fontSize: "0.86rem",
                  lineHeight: "1.6",
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
                {String(children).replace(/\n$/, "")}
              </SyntaxHighlighter>
            </div>
          );
        },
        p({ children }) {
          return <p>{children}</p>;
        },
        ul({ children }) {
          return <ul>{children}</ul>;
        },
        ol({ children }) {
          return <ol>{children}</ol>;
        },
        li({ children }) {
          return <li>{children}</li>;
        },
        h1({ children }) {
          return <h1>{children}</h1>;
        },
        h2({ children }) {
          return <h2>{children}</h2>;
        },
        h3({ children }) {
          return <h3>{children}</h3>;
        },
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
        blockquote({ children }) {
          return <blockquote>{children}</blockquote>;
        },
        hr() {
          return <hr />;
        },
        table({ children }) {
          return (
            <div className="table-wrapper">
              <table>{children}</table>
            </div>
          );
        },
        thead({ children }) {
          return <thead>{children}</thead>;
        },
        tbody({ children }) {
          return <tbody>{children}</tbody>;
        },
        tr({ children }) {
          return <tr>{children}</tr>;
        },
        th({ children }) {
          return <th>{children}</th>;
        },
        td({ children }) {
          return <td>{children}</td>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
