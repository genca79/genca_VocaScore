#!/usr/bin/env node
// build-icons — vendor a CLOSED, curated set of decorative icons from `lucide-static`
// into a project, as a generated, committed registry.
//
// Ships with the claude-tools plugin, but is meant to be COPIED INTO A PROJECT
// (conventionally `scripts/build-icons.mjs`) so the project can regenerate without the
// plugin installed — in CI, or by a colleague who does not have it. The curated name
// list lives in this file: adding an icon is `edit NAMES -> rerun -> update the pin`.
//
//   npm install -D lucide-static      (dev dependency ONLY — never a runtime dep)
//   node scripts/build-icons.mjs
//
// What ships is the GENERATED registry, not this script and not the dependency, so the
// project stays self-contained and the icon vocabulary stays a closed, reviewed set.
//
// See the claude-tools:asphi-icon-system skill for the full contract.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// CONFIGURATION — edit this block after copying the script into a project.
// ---------------------------------------------------------------------------

// The curated, CLOSED set. Each name is a file in node_modules/lucide-static/icons/.
// Pick one icon per RECURRING CONCEPT in the project's information architecture —
// never one per bullet, never two for the same concept. See references/icons/curation.md.
const NAMES = [
  // top bar: record / stop / listen / undo / redo / import / file menu / settings / help
  'mic',
  'square',
  'play',
  'repeat', // ascolto in loop
  'undo-2',
  'redo-2',
  'upload',
  'file',
  'settings',
  'keyboard',
  // file menu items
  'file-plus',
  'folder-open',
  'save',
  'download',
  // voices panel
  'plus',
  'volume-x',
  'headphones',
  'trash-2',
  // edit toolbar: semitone / octave / duplicate
  'chevron-up',
  'chevron-down',
  'chevrons-up',
  'chevrons-down',
  'copy',
];

// Output target: 'esm' | 'ts' | 'python' | 'php'
const FORMAT = 'esm';

// Where the generated registry + the upstream LICENSE are written, relative to the
// project root (the parent of the directory holding this script).
const OUT_DIR = 'src/icons';

// The exported symbol / function-name prefix used in the generated file.
const SYMBOL = 'ICON_SHAPES';

// ---------------------------------------------------------------------------
// Nothing below here normally needs editing.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const format = flag('format', FORMAT);
const outDir = resolve(ROOT, flag('out-dir', OUT_DIR));
const lucideDir = resolve(ROOT, flag('lucide', join('node_modules', 'lucide-static')));
const iconsDir = join(lucideDir, 'icons');

const names = flag('names', '')
  ? flag('names', '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
  : NAMES;

const FORMATS = {
  esm: { file: 'registry.js', comment: '//' },
  ts: { file: 'registry.ts', comment: '//' },
  python: { file: 'registry.py', comment: '#' },
  php: { file: 'icons-registry.php', comment: '//' },
};

function fail(message) {
  console.error(`build-icons: ${message}`);
  process.exit(1);
}

if (!FORMATS[format]) {
  fail(`unknown --format "${format}". Expected one of: ${Object.keys(FORMATS).join(', ')}.`);
}
if (names.length === 0) {
  fail('the curated NAMES list is empty — add the Lucide names this project actually needs.');
}
if (!existsSync(iconsDir)) {
  fail(
    `cannot find "${iconsDir}".\n` +
      '  Install the generator dependency first:  npm install -D lucide-static\n' +
      '  (dev dependency only — the generated registry is what ships).',
  );
}

// Provenance: record exactly which upstream release the geometry came from. Lucide
// renames icons between releases, so an upgrade is a reviewed change, not a bump.
let version = 'unknown';
try {
  version = JSON.parse(readFileSync(join(lucideDir, 'package.json'), 'utf8')).version || 'unknown';
} catch {
  /* provenance is best-effort; a missing package.json must not break the build */
}

// A Lucide icon is pure geometry — never scripts, event handlers, links, embedded or
// foreign content. Fail loudly if that ever changes upstream, so nothing unsafe is
// vendored. This THROWS rather than warning: a supply-chain guard that can be ignored
// is not a guard.
const UNSAFE = /<script|\son\w+=|href|xlink|<use\b|<image\b|<foreignObject|<style\b|<!DOCTYPE|<!ENTITY|javascript:/i;

// Keep only the shape elements: drop the license comment and the <svg> wrapper. The
// wrapper — with the a11y attributes and currentColor — is added by the project's icon
// module, so it lives in exactly one place. Whitespace is collapsed so the output is
// deterministic and compact (it is inlined into every page that uses an icon).
function innerShapes(svg) {
  const body = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  return body.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}

function suggest(name) {
  let available = [];
  try {
    available = readdirSync(iconsDir)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4));
  } catch {
    return '';
  }
  const stem = name.replace(/-\d+$/, '').split('-')[0];
  const near = available.filter((n) => n.includes(stem)).slice(0, 6);
  return near.length ? `\n  Did you mean: ${near.join(', ')}?` : '';
}

// Sorted, so the generated file is diff-stable regardless of how NAMES is ordered.
const entries = [...new Set(names)].sort().map((name) => {
  let svg;
  try {
    svg = readFileSync(join(iconsDir, `${name}.svg`), 'utf8');
  } catch {
    fail(
      `icon "${name}" is not in lucide-static@${version}.` +
        suggest(name) +
        '\n  Lucide renames icons between releases — check the name at https://lucide.dev/icons/',
    );
  }
  const shapes = innerShapes(svg);
  if (UNSAFE.test(shapes)) {
    fail(`icon "${name}" contains disallowed markup — refusing to vendor it. Nothing was written.`);
  }
  if (!shapes) {
    fail(`icon "${name}" produced empty geometry — refusing to vendor it. Nothing was written.`);
  }
  return [name, shapes];
});

const header = (c) =>
  [
    `${c} AUTO-GENERATED by scripts/build-icons.mjs — DO NOT EDIT BY HAND.`,
    `${c} Curated, CLOSED set of decorative icons vendored from lucide-static@${version} (ISC).`,
    `${c} See LICENSE-lucide.txt in this directory. Regenerate: node scripts/build-icons.mjs`,
    `${c} Each value is the inner shape markup of a 24x24 stroke icon; the <svg> wrapper`,
    `${c} (aria-hidden, brand colour via currentColor) is added by the icon module.`,
  ].join('\n');

const pairs = (indent, sep = ':') =>
  entries.map(([n, s]) => `${indent}${JSON.stringify(n)}${sep} ${JSON.stringify(s)},`).join('\n');

// PHP single-quoted literals: only \' and \\ are escapes, so nothing in the data can
// be interpolated (a double-quoted string would expand a `$` in the geometry).
const php = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function render() {
  switch (format) {
    case 'esm':
      return `${header('//')}

export const ${SYMBOL} = Object.freeze({
${pairs('  ')}
});
`;
    case 'ts':
      return `${header('//')}

export const ${SYMBOL} = Object.freeze({
${pairs('  ')}
} as const);

/** The closed icon vocabulary, enforced at compile time. */
export type IconName = keyof typeof ${SYMBOL};
`;
    case 'python':
      return `${header('#')}

from types import MappingProxyType
from typing import Mapping

${SYMBOL}: Mapping[str, str] = MappingProxyType(
    {
${entries.map(([n, s]) => `        ${JSON.stringify(n)}: ${JSON.stringify(s)},`).join('\n')}
    }
)
`;
    case 'php':
      return `<?php
${header('//')}

return [
${entries.map(([n, s]) => `    ${php(n)} => ${php(s)},`).join('\n')}
];
`;
    default:
      return fail(`unreachable format "${format}"`);
  }
}

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, FORMATS[format].file);
writeFileSync(outFile, render());

// Attribution travels with the vendored data, regenerated in lockstep.
try {
  copyFileSync(join(lucideDir, 'LICENSE'), join(outDir, 'LICENSE-lucide.txt'));
} catch {
  console.warn('build-icons: could not copy the upstream LICENSE — add the attribution by hand.');
}

console.log(
  `build-icons: wrote ${outFile} with ${entries.length} icon(s) from lucide-static@${version}; copied LICENSE-lucide.txt.`,
);
