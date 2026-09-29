// Assemble the installable OpenChamber extension package into dist/.
//
// dist/ is a complete package root: package.json sits at dist/package.json and the
// manifest entries resolve inside dist/ (panel/index.html, service/main.js, ...).
// The host loads built .js files as they sit in the package, so the HTML pages and
// their bundles must land in the same folder. dist/ is generated, never committed.
//
//     node scripts/build.mjs            (or: npm run build)

import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const bundler = path.join(root, 'node_modules', '@openchamber', 'sdk', 'scripts', 'bundle-guest.ts');

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('bun', args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`bun exited with code ${code}`))));
  });

// Start from a clean package root so removed files never linger in dist/.
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'panel'), { recursive: true });
await mkdir(path.join(dist, 'service'), { recursive: true });

// Static package files copied verbatim. The manifest in package.json points at
// panel/index.html, panel/background.html, service/main.js and icon.svg, so these
// paths must match the layout inside dist/.
await Promise.all([
  copyFile(path.join(root, 'package.json'), path.join(dist, 'package.json')),
  copyFile(path.join(root, 'icon.svg'), path.join(dist, 'icon.svg')),
  copyFile(path.join(root, 'panel', 'index.html'), path.join(dist, 'panel', 'index.html')),
  copyFile(path.join(root, 'panel', 'background.html'), path.join(dist, 'panel', 'background.html')),
]);

// Bundles: browser IIFE for the sandboxed panel, Node ESM for the host service.
await run([bundler, 'panel/main.ts', 'dist/panel/main.js']);
await run([bundler, '--node', 'service/main.ts', 'dist/service/main.js']);

console.log('Built dist/ (installable package).');
