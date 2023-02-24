import { extname, normalize, dirname, basename } from "https://deno.land/std/path/mod.ts";
import { walk, copy } from "https://deno.land/std/fs/mod.ts";
import { serve } from "https://deno.land/std/http/server.ts";
import { createExtractor, Format, Parser } from "https://deno.land/std/encoding/front_matter/mod.ts";
import { parse as parseYAML } from "https://deno.land/std/encoding/yaml.ts";
import { serveDir } from "https://deno.land/std/http/file_server.ts";

import { refresh } from "https://deno.land/x/refresh/mod.ts";
import { highlightText } from "https://deno.land/x/speed_highlight_js/src/index.js";
import { Marked } from "https://deno.land/x/markdown@v2.0.0/mod.ts";

// @deno-types="npm:@types/mithril@^2.0.3"
import {default as m} from "npm:mithril@^2.0.3";
import {default as render} from "npm:mithril-node-render";
import {default as pretty} from "npm:pretty";


// INTERNAL HELPERS

const merge = (a, b) => Object.assign({}, a, b);
const extractFrontMatter = createExtractor({ [Format.YAML]: parseYAML as Parser });
const exists = (pathname: string): boolean => {
  try {
    return Deno.statSync(pathname).isFile;
  } catch(e) {
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
  Marked.setOptions({highlight: (code, lang) => {i++; const key = `{{${i}}}`; ctx[key] = {code, lang}; return key; }});
  const out = Marked.parse(s);
  for (const key in ctx) {
    out.content = out.content.replace(key, await highlightText(ctx[key].code, ctx[key].lang));
  }
  return out.content;
};


// PUBLIC API

export {m as v}

export function view(defaults, viewFn) {
  return {
    view: (vnode) => {
      const attrs = merge(vnode.attrs, defaults);
      const body = viewFn(attrs, vnode.children);
      const layout = attrs.layout;
      if (layout) {
        delete attrs.layout;
        return m(layout, attrs, body);
      }
      return body;
    }
  }
}

export function pages(path?: string): Page[] {
  let prefix = instance.srcDir;
  if (path) {
    prefix += "/"+path;
  }
  return Object.values(instance.pages).filter(p => p.src.startsWith(prefix));
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
  pages: Record<string,Page>;

  constructor(config: Config) {
    this.config = merge({
      src: ".",
      dest: "./out",
      port: 9090
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
    if (["site.ts", "deno.json", "deno.lock"].includes(filename) 
          || filename.startsWith("_")
          || filename.startsWith(".")) {
      return true;
    }
    return false;
  }

  async layout(name?: string): any {
    let layoutPath = `${this.srcDir}/_layout.tsx`;
    if (name) {
      layoutPath = `${this.srcDir}/${name}/_layout.tsx`
    }
    if (exists(layoutPath)) {
      const layoutMod = await import(layoutPath);
      return layoutMod.default;
    }
    // passthrough layout
    return {view: ({children}) => children};
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

  async loadPage(srcPath: string): Page|null {
    let layout = await this.layout();
    let path = this.pagePath(srcPath);
    let page = null;
    switch (extname(srcPath)) {
      case ".md":
        const file = extractFrontMatter(await Deno.readTextFile(srcPath));
        const content = await parseMarkdown(file.body);
        layout = await this.layout(file.attrs.layout);
        delete file.attrs.layout;
        page = merge({
          src: srcPath,
          path: path,
          view: () => m(layout, merge(file.attrs, this.config.global), m.trust(content))
        }, file.attrs);
        this.pages[path] = page;
        break;
      case ".tsx":
        const mod = await import(srcPath);
        page = {
          src: srcPath,
          path: path,
          view: () => m(mod.default, merge({layout}, this.config.global))
        };
        this.pages[path] = page;
        break;
      // case ".json":
      //   break;
    }
    return page;
  }

  async loadAll() {
    for await(const e of walk(this.srcDir, {
      includeDirs: false,
    })) {
      if (this.ignorePath(e.path)) {
        continue;
      }
      await this.loadPage(e.path);
    }
  }

  async rebuild(path: string): string|null {
    const page = this.pages[path];
    if (!page) {
      return null;
    }
    const reloaded = await this.loadPage(page.src);
    return this.render(reloaded);
  }

  async render(page: Page): string {
    return "<!DOCTYPE html>\n"+pretty(render.sync(m(page)));
  }

  async buildAll() {
    await this.loadAll();
    for await(const e of walk(this.srcDir, {
      includeDirs: false,
    })) {
      if (this.ignorePath(e.path)) {
        continue;
      }
      const page = this.pages[this.pagePath(e.path)];
      if (page) {
        const out = await this.render(page);
        if (out) {
          const target = `${this.destDir}${page.path}/index.html`;
          mkdirAll(dirname(target));
          await Deno.writeTextFile(target, out);
        }
      } else {
        const relpath = e.path.replace(this.srcDir, "");
        const outpath = `${this.destDir}/${relpath}`;
        mkdirAll(dirname(outpath));
        copy(e.path, `${outpath}`, {overwrite: true});
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
          urlRoot: ""
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
            "expires": "0"
          },
        });  
      }
    
      return new Response("Not found", {
        status: 404,
        headers: {
          "content-type": "text/html",
        },
      });
    }, { port: this.config.port });
  }
}
