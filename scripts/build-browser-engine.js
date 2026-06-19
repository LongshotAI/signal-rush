#!/usr/bin/env node
/**
 * build-browser-engine.js
 *
 * Bundles the Signal Rush engine (src/core/engine.js + transitive deps)
 * into a single browser-loadable ESM file at dist/signal-rush-engine.mjs.
 *
 * The engine uses CommonJS (require/module.exports). esbuild converts
 * this to ESM automatically when we set format: 'esm'.
 */

const esbuild = require('esbuild');
const path = require('path');

const entry = path.resolve(__dirname, '..', 'src', 'core', 'engine.js');
const outFile = path.resolve(__dirname, '..', 'dist', 'signal-rush-engine.mjs');

async function main() {
  console.log('📦 Bundling Signal Rush engine for browser…');
  console.log(`   Entry:  ${entry}`);
  console.log(`   Output: ${outFile}`);

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: outFile,
    platform: 'browser',
    target: ['es2020'],
    treeShaking: true,
    metafile: true,
    logLevel: 'info',
    // The engine uses CommonJS internally. esbuild wraps it as ESM with
    // `export default require_engine()`. Game.js accesses via `.default`.
    // No footer needed — the default export works as-is.
  });

  const meta = result.metafile;
  if (meta) {
    const inputs = Object.keys(meta.inputs);
    console.log('\n📂 Bundled source files:');
    inputs.forEach((f) => console.log(`   • ${path.relative(path.resolve(__dirname, '..'), f)}`));

    for (const [file, info] of Object.entries(meta.outputs)) {
      const sizeKB = (info.bytes / 1024).toFixed(1);
      console.log(`\n✅ Output: ${path.relative(path.resolve(__dirname, '..'), file)} (${sizeKB} KB)`);
    }
  }

  console.log('\n🎉 Browser engine bundle ready.');
}

main().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
