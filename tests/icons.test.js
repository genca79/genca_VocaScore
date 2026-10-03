// @vitest-environment happy-dom
//
// Guard the curated decorative-icon set (see src/icons and scripts/build-icons.mjs):
//  1. a pin on the names, so the CLOSED vocabulary cannot drift silently;
//  2. every emitted icon is well-formed AND safe (defence in depth over the build-time check);
//  3. an unknown name fails safe (no icon, a warning, never an error);
//  4. every icon in the page sits beside visible text (never the only signal) and takes the
//     colour of that text (currentColor): its contrast is the label's contrast.
// To extend: add the Lucide name to NAMES in scripts/build-icons.mjs, rerun the generator,
// then add it here. Three reviewed steps, always.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_NAMES, decorateIcons, hasIcon, iconElement, iconMarkup, setIcon } from '../src/icons/index.js';

const CURATED = [
  'chevron-down',
  'chevron-up',
  'chevrons-down',
  'chevrons-up',
  'copy',
  'download',
  'file',
  'file-plus',
  'folder-open',
  'headphones',
  'keyboard',
  'mic',
  'play',
  'plus',
  'redo-2',
  'repeat',
  'save',
  'settings',
  'square',
  'trash-2',
  'undo-2',
  'upload',
  'volume-x',
];

describe('icon set', () => {
  it('matches the curated pin (no silent vocabulary drift)', () => {
    expect([...ICON_NAMES].sort()).toEqual(CURATED);
  });

  it('every icon emits a well-formed, purely decorative SVG', () => {
    for (const name of ICON_NAMES) {
      const svg = iconMarkup(name);
      expect(svg.startsWith('<svg') && svg.endsWith('</svg>'), name).toBe(true);
      expect(svg).toMatch(/viewBox="0 0 24 24"/);
      expect(svg).toMatch(/aria-hidden="true"/);
      expect(svg).toMatch(/role="presentation"/);
      expect(svg).toMatch(/focusable="false"/);
      expect(svg).toMatch(/stroke="currentColor"/);
      expect(svg).not.toMatch(/<script|\son\w+=|href|xlink|<use\b|<image\b|<foreignObject|<style\b|javascript:/i);
    }
  });

  it('an unknown icon fails safe', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(iconMarkup('definitely-not-an-icon')).toBe('');
    expect(iconElement('definitely-not-an-icon')).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(hasIcon('mic')).toBe(true);
    expect(hasIcon('toString')).toBe(false);
    warn.mockRestore();
  });

  it('setIcon replaces the icon and never touches the visible text', () => {
    const button = document.createElement('button');
    button.textContent = 'Registra';
    setIcon(button, 'mic');
    setIcon(button, 'square');
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(button.dataset.icon).toBe('square');
    expect(button.textContent).toBe('Registra');
  });
});

describe('icons in the page (index.html)', () => {
  document.body.innerHTML = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
    .replace(/^[\s\S]*<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '')
    .replace(/<script[\s\S]*?<\/script>/g, ''); // la pagina vera, senza caricare l'app
  decorateIcons(document);
  const decorated = [...document.querySelectorAll('[data-icon]')];

  it('every requested icon exists in the set', () => {
    expect(decorated.length).toBeGreaterThan(10);
    for (const el of decorated) expect(hasIcon(el.dataset.icon), el.dataset.icon).toBe(true);
  });

  it('every icon sits beside visible text: the element still has a name without the icon', () => {
    for (const el of decorated) {
      expect(el.querySelectorAll('svg.icon')).toHaveLength(1);
      expect(el.textContent.trim().length, el.outerHTML.slice(0, 80)).toBeGreaterThan(1);
    }
  });

  it('the icon colour is the label colour (currentColor), not a colour of its own', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles', 'main.css'), 'utf8');
    const rule = css.match(/\.icon \{[^}]*\}/)[0];
    expect(rule).toMatch(/color: var\(--icon-color, currentColor\)/);
    expect(css).not.toMatch(/--icon-color:\s*#/); // nessun colore fisso per le icone
  });
});
