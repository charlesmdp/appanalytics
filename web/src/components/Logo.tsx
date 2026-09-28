/**
 * The P monogram.
 *
 * Geometry rather than a typeface: the mark has to hold together at 16px in a
 * browser tab, where a font's thin counter would close up and the P would read
 * as a filled blob. The stem is 4 units wide against a 3.5 bowl, which is the
 * usual typographic weighting — a P whose stem matches its bowl looks limp.
 *
 * The same two paths are hardcoded in `web/public/favicon.svg`, which cannot
 * import this file or read a custom property. Change one, change the other.
 *
 * The tile keeps the brand hex in both themes rather than following
 * `--brand-accent`: white on `#2E72D2` clears 4.7:1 either way, so the mark is
 * the one thing on screen that does not move when the theme flips.
 */

/** Outer letterform, then the counter that fill-rule="evenodd" punches out. */
const P_PATH = 'M9 7H16.5A6 6 0 0 1 16.5 19H13V25H9Z M13 10.5H16.5A2.5 2.5 0 0 1 16.5 15.5H13Z';

export function Logo() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      {/* Drawn as a rounded rect rather than a CSS background so the mark stays
          one element — and so the favicon file can be a copy of this markup. */}
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path d={P_PATH} fill="var(--brand-on)" fillRule="evenodd" />
    </svg>
  );
}
