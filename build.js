import esbuild from 'esbuild';
import fs from 'fs';

const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node16',
  external: ['mysql2'],
};

await esbuild.build({
  ...shared,
  format: 'esm',
  outdir: 'dist/esm',
});

await esbuild.build({
  ...shared,
  format: 'cjs',
  outdir: 'dist/cjs',
});

// Mark dist/cjs as CommonJS so require() works even when root has "type":"module"
fs.writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2));
// Mark dist/esm as ES Module explicitly
fs.writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2));

console.log('Build complete: dist/esm + dist/cjs');
