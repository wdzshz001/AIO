import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const OUT = path.join(ROOT, 'apps/desktop/dist');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

function rendererOpts() {
  return {
    ...common,
    entryPoints: [path.join(ROOT, 'packages/ui/src/main.tsx')],
    outfile: path.join(OUT, 'renderer.js'),
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    jsx: 'automatic',
    loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
  };
}

function mainOpts() {
  return {
    ...common,
    entryPoints: [path.join(ROOT, 'apps/desktop/src/main.ts')],
    outfile: path.join(OUT, 'main.cjs'),
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    external: ['electron'],
  };
}

function preloadOpts() {
  return {
    ...common,
    entryPoints: [path.join(ROOT, 'apps/desktop/src/preload.ts')],
    outfile: path.join(OUT, 'preload.cjs'),
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    external: ['electron'],
  };
}

function copyStatic() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'packages/ui/index.html'),
    path.join(OUT, 'index.html'),
  );
}

export async function buildAll({ watch = false } = {}) {
  copyStatic();
  const opts = [rendererOpts(), mainOpts(), preloadOpts()];
  if (watch) {
    for (const o of opts) {
      const ctx = await context(o);
      await ctx.watch();
    }
    return;
  }
  await Promise.all(opts.map((o) => build(o)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
