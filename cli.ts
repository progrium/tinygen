import { Generator } from "./tinygen.ts";

async function currentSite() {
  return new Generator((await import(`file://${Deno.cwd()}/site.ts`)).default);
}

export async function build() {
  const site = await currentSite();
  await site.buildAll();
}

export async function serve() {
  const site = await currentSite();
  await site.serve();
}

if (import.meta.main) {
  switch (Deno.args[0]) {
    case "build":
      await build();
      break;
    case "serve":
      await serve();
      break;
  }
}
