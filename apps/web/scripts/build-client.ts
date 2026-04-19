#!/usr/bin/env bun
/**
 * Build the SolidJS SPA bundle to `dist/public/`.
 *
 * Pipeline:
 *   1. `Bun.build` with `bun-plugin-solid` to compile `.tsx` → JSX-as-runtime
 *      output. Emits `dist/public/assets/index.js`.
 *   2. Copy `index.html` (adjusting asset URLs) and `styles.css` into
 *      `dist/public/`.
 *
 * Kept as a standalone script (not a `package.json` `build` one-liner)
 * because we want symbol-level control over the bundle layout: the server
 * serves `/assets/*` for hashed bundles and `/` for the shell HTML.
 */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SolidPlugin } from "bun-plugin-solid";

const here = dirname(new URL(import.meta.url).pathname);
const appRoot = resolve(here, "..");
const srcRoot = resolve(appRoot, "src", "frontend");
const outRoot = resolve(appRoot, "dist", "public");
const assetsRoot = resolve(outRoot, "assets");

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function buildJs(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(srcRoot, "index.tsx")],
    outdir: assetsRoot,
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    plugins: [SolidPlugin()],
    naming: {
      entry: "[name].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("client bundle failed");
  }
}

async function copyStatics(): Promise<void> {
  const html = await readFile(resolve(srcRoot, "index.html"), "utf8");
  await writeFile(resolve(outRoot, "index.html"), html, "utf8");
  await cp(resolve(srcRoot, "styles.css"), resolve(assetsRoot, "styles.css"));
}

async function main(): Promise<void> {
  await ensureDir(assetsRoot);
  await buildJs();
  await copyStatics();
  console.warn(`built client bundle → ${outRoot}`);
}

await main();
