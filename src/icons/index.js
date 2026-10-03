// Curated decorative icons — the public API over the generated registry.
//
// Icons are an ACCENT, never information: every icon is an inline
// <svg aria-hidden="true" focusable="false"> coloured by currentColor (the colour of the
// label it sits beside), always paired with visible text. The set is CLOSED — an unknown
// name renders nothing and warns. Regenerate the data with `node scripts/build-icons.mjs`.

import { ICON_SHAPES } from './registry.js';

/** The available icon names, sorted. Pinned in tests/icons.test.js. */
export const ICON_NAMES = Object.freeze(Object.keys(ICON_SHAPES));

export function hasIcon(name) {
  // hasOwnProperty via call: `hasIcon('toString')` must be false.
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICON_SHAPES, name);
}

/**
 * The single place the <svg> wrapper — and its a11y + colour contract — is defined.
 * Returns '' for an unknown name so callers fail safe to no icon.
 */
export function iconMarkup(name, extraClass = '') {
  const shapes = ICON_SHAPES[name];
  if (!shapes) return '';
  const cls = extraClass ? `icon ${extraClass}` : 'icon';
  return (
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    `role="presentation" aria-hidden="true" focusable="false">${shapes}</svg>`
  );
}

/** The icon as a DOM element (built from iconMarkup), or null for an unknown name (with a warning). */
export function iconElement(name) {
  if (!hasIcon(name)) {
    console.warn(`Unknown icon "${name}": no icon rendered (see src/icons).`);
    return null;
  }
  const template = document.createElement('template');
  template.innerHTML = iconMarkup(name);
  return template.content.firstElementChild;
}

/** Puts the icon named by `data-icon` at the start of every such element under `root`. */
export function decorateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) setIcon(el, el.dataset.icon);
}

/** Replaces the icon of an element (e.g. Registra → Stop); the visible text is never touched. */
export function setIcon(el, name) {
  el.querySelector(':scope > svg.icon')?.remove();
  const svg = iconElement(name);
  if (svg) el.prepend(svg);
  el.dataset.icon = name;
}
