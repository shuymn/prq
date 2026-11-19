import "./Markdown.css";
import { createContext, memo, type ReactNode, use } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "./CodeBlock.tsx";

// An absolute URL of one of these schemes, or null: a relative URL, mailto: and every other scheme are not followed.
function absolute(href: string | undefined, schemes: readonly string[]): string | null {
  const url = href === undefined ? null : URL.parse(href);
  return url !== null && schemes.includes(url.protocol) ? url.href : null;
}

// Inside a link: an image there is its alt text, so a linked image is one link, whatever inline nodes hold it.
const InLink = createContext(false);

// A link opens in a new tab when it is an absolute http(s) URL; any other is its text alone.
function MarkdownLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const target = absolute(href, ["https:", "http:"]);
  const label = <InLink value>{children}</InLink>;
  return target === null ? (
    <span>{label}</span>
  ) : (
    <a href={target} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

// An image is never fetched: in a link, its alt text (its address when it has none); else an https URL is a link named
// by the alt text, anything else the alt text alone.
function MarkdownImage({ src, alt }: { src?: unknown; alt?: string | undefined }) {
  const address = typeof src === "string" ? src : "";
  const label = alt ?? "";
  if (use(InLink)) {
    return label === "" ? address : label;
  }
  const target = absolute(address, ["https:"]);
  return target === null ? (
    <span>{label}</span>
  ) : (
    <a href={target} target="_blank" rel="noreferrer">
      {label === "" ? target : label}
    </a>
  );
}

const COMPONENTS: Components = {
  // A fenced block: the parser's one code element, its one text (less the newline it ends with) and its language class.
  pre({ node }) {
    const code = node?.children[0];
    const element = code?.type === "element" ? code : undefined;
    const text = element?.children[0];
    const classes = element?.properties["className"];
    const language = Array.isArray(classes)
      ? classes
          .map(String)
          .find((name) => name.startsWith("language-"))
          ?.slice("language-".length)
      : undefined;
    return <CodeBlock code={text?.type === "text" ? text.value.replace(/\n$/, "") : ""} language={language} />;
  },
  // A table scrolls sideways within its own box when it is wider than the content.
  table({ children }) {
    return (
      <div className="table">
        <table>{children}</table>
      </div>
    );
  },
  a: MarkdownLink,
  img: MarkdownImage,
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
