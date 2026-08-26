import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { stripCriticMarkup } from "./editor/notes";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LANGUAGE =
  /^(?:lang|language):[ \t]*(["']?)([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\1[ \t]*\r?$/im;

export interface RenderedMarkdown {
  html: string;
  lang: string;
}

export function renderMarkdown(
  source: string,
  novelProof = false,
): RenderedMarkdown {
  const frontMatter = FRONT_MATTER.exec(source);
  const metadata = frontMatter?.[1] ?? "";
  const metadataLang = LANGUAGE.exec(metadata)?.[2];
  const body =
    novelProof && frontMatter && metadataLang
      ? source.slice(frontMatter[0].length)
      : source;
  const lang =
    metadataLang ||
    navigator.language ||
    document.documentElement.lang ||
    "en";
  return {
    html: DOMPurify.sanitize(markdown.render(stripCriticMarkup(body))),
    lang,
  };
}
