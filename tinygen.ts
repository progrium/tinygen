import { basename, dirname, extname, normalize } from "https://deno.land/std/path/mod.ts";
import { copy, walk } from "https://deno.land/std/fs/mod.ts";
import { serve } from "https://deno.land/std/http/server.ts";
import { createExtractor, Format, Parser } from "https://deno.land/std/encoding/front_matter/mod.ts";
import { parse as parseYAML } from "https://deno.land/std/encoding/yaml.ts";
import { serveDir } from "https://deno.land/std/http/file_server.ts";
import { writeAll } from "https://deno.land/std@0.178.0/streams/write_all.ts";

import { refresh } from "https://deno.land/x/refresh/mod.ts";
import { highlightText } from "https://deno.land/x/speed_highlight_js/src/index.js";
import { Marked } from "https://deno.land/x/markdown@v2.0.0/mod.ts";

// INTERNAL HELPERS

const merge = (...objs) => Object.assign({}, ...objs);
const extractFrontMatter = createExtractor({
  [Format.YAML]: parseYAML as Parser,
});
const exists = (pathname: string): boolean => {
  try {
    return Deno.statSync(pathname).isFile;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};
const mkdirAll = (path: string) => {
  try {
    Deno.mkdirSync(path, { recursive: true });
  } catch {}
};
const parseMarkdown = async (s: string): string => {
  let [ctx, i] = [{}, 0];
  // hack to get around markdown library not supporting async hightlighting
  Marked.setOptions({
    highlight: (code, lang) => {
      i++;
      const key = `{{${i}}}`;
      ctx[key] = { code, lang };
      return key;
    },
  });
  const out = Marked.parse(s);
  for (const key in ctx) {
    out.content = out.content.replace(
      key,
      await highlightText(ctx[key].code, ctx[key].lang),
    );
  }
  return out.content;
};

async function pretty(str) {
  const p = Deno.run({cmd: ["deno", "fmt", "-"], stdin: "piped", stdout: "piped"});
  await writeAll(p.stdin, new TextEncoder().encode(str))
  p.stdin.close()
  const out = new TextDecoder().decode(await p.output());
  return out.substring(0, out.length-2); // remove added ";\n"
}

function render(hyperscript) {
  if (hyperscript === undefined) return "";
  const toCssName = (str) => str.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  const renderStyles = (styles) => Object.keys(styles).map(style => [toCssName(style), styles[style]].join(": ")+";").join(" ");
  const renderAttrs = (attrs) => Object.keys(attrs).map(attr => [attr, `"${(typeof attrs[attr] === 'object')?renderStyles(attrs[attr]):attrs[attr]}"`].join("=")).join(" ");
  if (typeof hyperscript === 'string') return hyperscript;
  let {tag, attrs, children} = hyperscript;
  if (typeof tag === 'object') {
    const v = tag.view({attrs, children});
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(c => render(c)).join("");
    if (typeof v.tag === 'object') return render(v);
    tag = v.tag; attrs = v.attrs; children = v.children;
  }
  let opentag = tag;
  let tagattrs = renderAttrs(attrs||{});
  if (tagattrs) {
    opentag = `${tag} ${tagattrs}`
  }
  if (children) {
    return `<${opentag}>${children.map(c => render(c)).join("")}</${tag}>`
  }
  return `<${opentag} />`
}

// PUBLIC API


export function v(tag, attrs, ...children) {
  if (children && children.length === 1 && Array.isArray(children[0])) {
    children = children[0];
  }
  return {tag, attrs, children};
}

export function view(defaults, viewFn) {
  if (defaults instanceof Function) {
    viewFn = defaults;
    defaults = {};
  }
  return {
    view: (vnode) => {
      const attrs = merge(vnode.attrs, defaults, {content: vnode.children});
      const layout = attrs.layout;
      if (layout) {
        delete attrs.layout;
        return v(layout, attrs, viewFn(attrs));
      }
      return viewFn(attrs);
    },
  };
}

export function pages(path?: string): Page[] {
  let prefix = instance.srcDir;
  if (path) {
    prefix += "/" + path;
  }
  return Object.values(instance.pages).filter((p) => p.src.startsWith(prefix));
}

export interface Config {
  src: string;
  dest: string;
  port: number;
  global: Object;
}

export interface Page {
  src: string;
  path: string;
  view: any;
  // +frontmatter data
}

let instance = undefined;
export class Generator {
  config: Config;
  pages: Record<string, Page>;

  constructor(config: Config) {
    this.config = merge({
      src: ".",
      dest: "./out",
      port: 9090,
    }, config);
    this.pages = {};
    instance = this;
  }

  get srcDir(): string {
    return Deno.realPathSync(normalize(this.config.src));
  }

  get destDir(): string {
    mkdirAll(normalize(this.config.dest));
    return Deno.realPathSync(normalize(this.config.dest));
  }

  ignorePath(path: string): boolean {
    if (path.startsWith(this.destDir)) {
      return true;
    }
    const filename = basename(path);
    if (
      ["site.ts", "deno.json", "deno.lock"].includes(filename) ||
      filename.startsWith("_") ||
      filename.startsWith(".")
    ) {
      return true;
    }
    return false;
  }

  async layout(name?: string|null): any {
    const passthrough = {view: ({children}) => children};
    if (name === null) return passthrough;
    let layoutPath = `${this.srcDir}/_layout.tsx`;
    if (name) {
      layoutPath = `${this.srcDir}/${name}/_layout.tsx`
    }
    if (exists(layoutPath)) {
      const layoutMod = await import("file://"+layoutPath);
      return layoutMod.default;
    }
    return passthrough;
  }

  pagePath(srcPath: string): string {
    let path = srcPath
      .replace(this.srcDir, "")
      .replace(extname(srcPath), "")
      .replace(/\/index$/, "");
    if (!path) {
      path = "/";
    }
    return path;
  }

  async loadPage(srcPath: string): Page | null {
    let layout = await this.layout();
    let path = this.pagePath(srcPath);
    let page = null;
    switch (extname(srcPath)) {
      case ".md":
        let contents = await Deno.readTextFile(srcPath);
        if (!contents.startsWith("---")) {
          contents = `---\n---\n${contents}`;
        }
        const file = extractFrontMatter(contents);
        file.attrs = file.attrs || {};
        const content = await parseMarkdown(file.body);
        layout = await this.layout(file.attrs.layout);
        delete file.attrs.layout;
        page = merge({
          src: srcPath,
          path: path,
          view: () => v(layout, merge(this.config.global, file.attrs, {path}), content /*m.trust(content)*/),
        }, file.attrs);
        this.pages[path] = page;
        break;
      case ".tsx":
        const mod = await import("file://"+srcPath);
        page = {
          src: srcPath,
          path: path,
          view: () => v(mod.default, merge(this.config.global, {layout, path})),
        };
        this.pages[path] = page;
        break;
        // case ".json":
        //   break;
    }
    return page;
  }

  async loadAll() {
    for await (
      const e of walk(this.srcDir, {
        includeDirs: false,
      })
    ) {
      if (this.ignorePath(e.path)) {
        continue;
      }
      await this.loadPage(e.path);
    }
  }

  async rebuild(path: string): string | null {
    const page = this.pages[path];
    if (!page) {
      return null;
    }
    const reloaded = await this.loadPage(page.src);
    return this.render(reloaded);
  }

  async render(page: Page): string {
    const output = await pretty(render(v(page)));
    switch (extname(page.path)) {
      case ".xml":
        return `<?xml version="1.0" encoding="UTF-8" ?>\n${output}`;
      default:
        return "<!DOCTYPE html>\n"+output;
    }
  }

  async buildAll() {
    await this.loadAll();
    for await (
      const e of walk(this.srcDir, {
        includeDirs: false,
      })
    ) {
      if (this.ignorePath(e.path)) {
        continue;
      }
      const page = this.pages[this.pagePath(e.path)];
      if (page) {
        const out = await this.render(page);
        if (out) {
          const path = (extname(page.path)?page.path:`${page.path}/index.html`)
          const target = `${this.destDir}${path}`;
          mkdirAll(dirname(target));
          await Deno.writeTextFile(target, out);
        }
      } else {
        const relpath = e.path.replace(this.srcDir, "");
        const outpath = `${this.destDir}/${relpath}`;
        mkdirAll(dirname(outpath));
        copy(e.path, `${outpath}`, { overwrite: true });
      }
    }
  }

  async serve() {
    this.config.global.dev = true;
    const middleware = refresh({
      debounce: 100,
    });
    await this.loadAll();
    await serve(async (req) => {
      const res = middleware(req);
      if (res) {
        return res;
      }

      let pathname = new URL(req.url).pathname;

      if (pathname !== "/" && exists(`${this.srcDir}${pathname}`)) {
        return serveDir(req, {
          fsRoot: this.srcDir,
          urlRoot: "",
        });
      }

      const out = await this.rebuild(pathname);
      if (out) {
        return new Response(out, {
          status: 200,
          headers: {
            "content-type": "text/html",
            "cache-control": "no-cache, no-store, must-revalidate",
            "pragma": "no-cache",
            "expires": "0",
          },
        });
      }
      return new Response("Not found", {status: 404, headers: {"content-type": "text/html"}});
    }, { port: this.config.port || 9090 });
  }
}

async function currentSite() {
  return new Generator((await import(`file://${Deno.cwd()}/site.ts`)).default);
}

export async function runBuild() {
  const site = await currentSite();
  await site.buildAll();
}

export async function runServe() {
  const site = await currentSite();
  await site.serve();
}

export async function run() {
  const site = await currentSite();
  switch (Deno.args[0]) {
    case "build":
      await site.buildAll();
      return;
    case "serve":
      await site.serve();
      return;
  }
}
