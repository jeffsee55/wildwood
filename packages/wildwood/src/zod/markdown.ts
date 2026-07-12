import yaml from "js-yaml";
import type { Root } from "mdast";
import {
  directiveFromMarkdown,
  directiveToMarkdown,
} from "mdast-util-directive";
import { fromMarkdown as mdastFromMarkdown } from "mdast-util-from-markdown";
import {
  frontmatterFromMarkdown,
  frontmatterToMarkdown,
} from "mdast-util-frontmatter";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown as mdastToMarkdown } from "mdast-util-to-markdown";
import { directive } from "micromark-extension-directive";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import type { Position } from "unist";

declare module "mdast" {
  interface Root {
    /**
     * Any extra data you want to carry on your AST.
     * Now everywhere you see `Root` you’ll get this field too.
     */
    links?: { url: string; position?: Position }[];
    leafDirectives?: { name: string; [key: string]: unknown }[];
    raw?: string;
  }
}

export function fromMarkdown(string: string): Root {
  const tree = mdastFromMarkdown(string, {
    extensions: [gfm(), frontmatter(), directive()],
    mdastExtensions: [
      gfmFromMarkdown(),
      frontmatterFromMarkdown(["yaml", "toml"]),
      directiveFromMarkdown(),
    ],
  });
  return tree;
}

export function toMarkdown(tree: {
  [key: string]: unknown;
  _body: Root;
}): string {
  const { _body, ...frontmatter } = tree;
  if (Object.keys(frontmatter).length > 0) {
    _body.children.unshift({
      type: "yaml",
      value: yaml.dump(frontmatter).trim(),
    });
  }
  const string = mdastToMarkdown(_body, {
    extensions: [
      gfmToMarkdown(),
      directiveToMarkdown(),
      frontmatterToMarkdown(["yaml", "toml"]),
    ],
  });
  return string;
}
