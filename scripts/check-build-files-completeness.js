#!/usr/bin/env node
/**
 * Packaged-build file-completeness check.
 *
 * package.json's `build.files` is a hand-maintained allowlist of what
 * electron-builder puts in the installed app. A local file that the app loads
 * but that is missing from the list works fine from source (npm start) and is
 * simply absent from the installer - e.g. shopify.js, pane-controller.js,
 * filters-pane.js, orders-pane.js and toolbar-sync.js shipped missing once.
 *
 * This statically collects every local file the app loads and fails (exit 1)
 * listing any that `build.files` does not cover:
 *   - index.html: <script src>, <link href> (css, manifest, icons) and <img src>
 *   - main.js and preload.js: require('./x') / require('../x'), followed
 *     transitively through every local .js file they pull in
 *   - main.js: path.join(__dirname|appDir, 'x.ext') references (workers, server-bridge.js, assets)
 * Bare-module requires (node_modules) are out of scope; electron-builder
 * bundles production dependencies itself, and package.json is always included.
 *
 * Usage:  node scripts/check-build-files-completeness.js
 * As a module: require('./check-build-files-completeness').check({ root, buildFiles })
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..');

// Entry points whose require() graph is walked. index.html is handled separately.
const REQUIRE_ENTRIES = ['main.js', 'preload.js'];
// Only these get scanned for path.join(__dirname, '<file>') references.
const DIRNAME_REF_ENTRIES = ['main.js'];
const DIRNAME_REF_EXTS = ['js', 'html', 'css', 'json', 'png', 'ico', 'jpg', 'svg', 'webmanifest'];

const toPosix = (p) => p.split(path.sep).join('/');

/** Compile one electron-builder `files` glob into a RegExp over posix paths relative to the app root. */
function globToRegExp(glob) {
  let g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } // "**/" = zero or more directories
        else re += '.*';                                  // trailing "**" = anything beneath
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

/** Returns isCovered(relPosixPath) honouring "!negated" entries (later entries win, as in electron-builder). */
function buildCoverageMatcher(buildFiles) {
  const rules = buildFiles
    .filter((e) => typeof e === 'string')
    .map((e) => (e.startsWith('!') ? { neg: true, re: globToRegExp(e.slice(1)) } : { neg: false, re: globToRegExp(e) }));
  return (rel) => {
    let covered = false;
    for (const r of rules) {
      if (r.re.test(rel)) covered = !r.neg;
      // a bare directory entry ("guide") covers its contents too
      else if (!r.neg && r.re.test(rel.split('/').slice(0, -1).join('/'))) covered = true;
    }
    return covered;
  };
}

/** Drop comment text that commonly mentions example requires, without risking string contents. */
function stripObviousComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '') // block comments that start a line
    .replace(/^[ \t]*\/\/.*$/gm, '');         // whole-line // comments
}

/** Resolve a relative require specifier from `fromFile` to an existing file, the way Node would. */
function resolveLocalRequire(root, fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* try next */ }
  }
  return null;
}

function relFromRoot(root, abs) {
  return toPosix(path.relative(root, abs));
}

function check({ root = DEFAULT_ROOT, buildFiles } = {}) {
  if (!buildFiles) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    buildFiles = (pkg.build && pkg.build.files) || [];
  }
  const isCovered = buildCoverageMatcher(buildFiles);
  // electron-builder always packages package.json regardless of `files`.
  const alwaysIncluded = new Set(['package.json']);

  /** relPath -> Set of "who references it" descriptions */
  const referenced = new Map();
  /** unresolvable specifiers -> Set of sources */
  const unresolved = new Map();
  const note = (map, key, source) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(source);
  };

  // --- index.html -----------------------------------------------------------
  const htmlPath = path.join(root, 'index.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const refs = [];
    for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
    // Any local <link href> (stylesheet, manifest, icon, apple-touch-icon, ...) and <img src>.
    for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
    for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
    for (let ref of new Set(refs)) {
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue; // http:, data:, //cdn...
      ref = ref.split(/[?#]/)[0].replace(/^\.?\//, '');
      if (!ref) continue;
      const abs = path.join(root, ref);
      const rel = relFromRoot(root, abs);
      note(referenced, rel, 'index.html');
      if (!fs.existsSync(abs)) note(unresolved, rel, 'index.html');
    }
  }

  // --- main.js / preload.js require graph ----------------------------------
  const seen = new Set();
  const queue = [];
  for (const entry of REQUIRE_ENTRIES) {
    const abs = path.join(root, entry);
    if (fs.existsSync(abs)) { queue.push(abs); note(referenced, entry, 'entry point'); }
  }
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.js$/.test(file)) continue; // only walk JS; .json etc. are leaves
    const fromRel = relFromRoot(root, file);
    const src = stripObviousComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\brequire\(\s*(['"`])(\.{1,2}\/[^'"`$]+)\1\s*\)/g)) {
      const spec = m[2];
      const resolved = resolveLocalRequire(root, file, spec);
      if (!resolved) {
        note(unresolved, `${spec} (from ${fromRel})`, fromRel);
        continue;
      }
      const rel = relFromRoot(root, resolved);
      if (rel.startsWith('..')) continue; // outside the app root - not packaged by `files`
      note(referenced, rel, fromRel);
      queue.push(resolved);
    }
    // path.join(__dirname, 'scan-worker.js') style loads (workers, assets). main.js
    // also uses `const appDir = __dirname;` for server-bridge.js and static assets.
    if (DIRNAME_REF_ENTRIES.includes(fromRel)) {
      const extAlt = DIRNAME_REF_EXTS.join('|');
      const re = new RegExp(`path\\.join\\(\\s*(?:__dirname|appDir)\\s*,\\s*(['"])([^'"\\/][^'"]*\\.(?:${extAlt}))\\1\\s*\\)`, 'g');
      for (const m of src.matchAll(re)) {
        const abs = path.join(root, m[2]);
        const rel = relFromRoot(root, abs);
        if (rel.startsWith('..')) continue;
        note(referenced, rel, `${fromRel} (path.join(__dirname, '${m[2]}'))`);
        if (!fs.existsSync(abs)) note(unresolved, `${rel} (from ${fromRel})`, fromRel);
        else if (/\.js$/.test(abs)) queue.push(abs); // a worker's own requires matter too
      }
    }
  }

  const missing = [];
  for (const [rel, sources] of referenced) {
    if (alwaysIncluded.has(rel)) continue;
    if (!isCovered(rel)) missing.push({ file: rel, referencedBy: [...sources] });
  }
  missing.sort((a, b) => a.file.localeCompare(b.file));

  return {
    referencedCount: referenced.size,
    missing,
    unresolved: [...unresolved].map(([ref, sources]) => ({ ref, referencedBy: [...sources] }))
  };
}

function main() {
  const result = check();
  console.log(`[build-files] ${result.referencedCount} local files referenced by index.html / main.js / preload.js (and their requires)`);
  let failed = false;

  if (result.missing.length) {
    failed = true;
    console.error(`\n[build-files] FAIL: ${result.missing.length} referenced file(s) are NOT covered by package.json build.files.`);
    console.error('They will work from source but be missing from the packaged installer:\n');
    for (const m of result.missing) {
      console.error(`  - ${m.file}\n      referenced by: ${m.referencedBy.join(', ')}`);
    }
    console.error('\nAdd the missing entries to "build.files" in package.json (or a glob that covers them).');
  }
  if (result.unresolved.length) {
    failed = true;
    console.error(`\n[build-files] FAIL: ${result.unresolved.length} reference(s) point at a file that does not exist:\n`);
    for (const u of result.unresolved) {
      console.error(`  - ${u.ref}\n      referenced by: ${u.referencedBy.join(', ')}`);
    }
  }
  if (failed) process.exit(1);
  console.log('[build-files] OK: every referenced local file is covered by build.files');
}

if (require.main === module) main();

module.exports = { check, globToRegExp, buildCoverageMatcher };
