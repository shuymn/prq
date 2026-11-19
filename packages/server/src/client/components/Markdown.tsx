import "./Markdown.css";
import { memo } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "./CodeBlock.tsx";

// The syntax tree's element, as react-markdown passes it to a component, and what an element holds.
type Element = NonNullable<ExtraProps["node"]>;
type ElementContent = Element["children"][number];

// The text of a syntax tree's node, as a code block holds it.
function textOf(node: Element | ElementContent): string {
  if (node.type === "text") {
    return node.value;
  }
  return "children" in node ? node.children.map(textOf).join("") : "";
}

// An absolute URL of one of these schemes, or null: a relative URL, mailto: and every other scheme are not followed.
function absolute(href: string | undefined, schemes: readonly string[]): string | null {
  const url = href === undefined ? null : URL.parse(href);
  return url !== null && schemes.includes(url.protocol) ? url.href : null;
}

const COMPONENTS: Components = {
  // A fenced block: its text once, and its language from the class the parser gives its code.
  pre({ node }) {
    const code = node?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
    const classes = code?.properties["className"];
    const language = Array.isArray(classes)
      ? classes
          .map(String)
          .find((name) => name.startsWith("language-"))
          ?.slice("language-".length)
      : undefined;
    return <CodeBlock code={(code === undefined ? "" : textOf(code)).replace(/\n$/, "")} language={language} />;
  },
  // A table scrolls sideways within its own box when it is wider than the content.
  table({ children }) {
    return (
      <div className="table">
        <table>{children}</table>
      </div>
    );
  },
  // A link opens in a new tab when it is an absolute http(s) URL; any other is its text alone.
  a({ href, children }) {
    const target = absolute(href, ["https:", "http:"]);
    return target === null ? (
      <span>{children}</span>
    ) : (
      <a href={target} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  // An image is never fetched: an https URL is a link named by the alt text, anything else the alt text alone.
  img({ src, alt }) {
    const target = absolute(typeof src === "string" ? src : undefined, ["https:"]);
    const label = alt ?? "";
    return target === null ? (
      <span>{label}</span>
    ) : (
      <a href={target} target="_blank" rel="noreferrer">
        {label === "" ? target : label}
      </a>
    );
  },
};

// A summary or an answer, which an agent wrote in Markdown (design/components.md, PR detail): GitHub's extensions,
// and no raw HTML: react-markdown renders HTML in the text as text, and nothing assigns markup.
// Memoized: a streamed chunk renders the page again, and a text that did not change need not be parsed again.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div data-component="Markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
