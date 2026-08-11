// Regenerates the app icon from build/mark.svg.
//
//   npm run icon      (needs Xcode 26+ for actool)
//
// macOS 26 icons are not drawn artwork but a recipe: AppIcon.icon holds the bare mark plus
// icon.json (tile fill, translucency, shadow), and the OS renders the Liquid Glass material
// live — specular edges, tilt highlights, light/dark/tinted variants. actool compiles that
// recipe into:
//
//   glass/Assets.car   the live icon; bundled into the packaged app next to a
//                      CFBundleIconName so the Dock renders true glass (see package.json)
//   glass/AppIcon.icns Apple's own flattened render, kept as build/icon.icns for
//                      pre-Tahoe macOS and legacy contexts
//   icon-1024.png      extracted from that icns; the Dock icon for unpackaged `npm start`,
//                      where electron-builder's bundle wiring doesn't apply
//
// The layer inside AppIcon.icon is generated here at 1024 with the mark centred on its ink
// bounds (it sits off-centre in mark.svg's 50x50 viewBox) at 62% height — a step up from the ~52%
// Figma uses, since this mark reads small for its box. Don't hand-edit AppIcon.icon/Assets/mark.svg; change mark.svg or
// the numbers below and rerun. icon.json is authored by hand and safe to tune (it's the
// Icon Composer document format).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// -- compose the 1024 layer from the bare mark ------------------------------------------
const mark = fs.readFileSync(path.join(here, 'mark.svg'), 'utf8');
const body = mark.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1].trim();

const INK = { x: 10, y: 7, w: 30, h: 35 }; // the mark's ink within mark.svg's 50x50 viewBox
const CANVAS = 1024;
const HEIGHT = CANVAS * 0.62;

const s = HEIGHT / INK.h;
const tx = CANVAS / 2 - (INK.x + INK.w / 2) * s;
const ty = CANVAS / 2 - (INK.y + INK.h / 2) * s;

const layer = `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})">
${body
  .split('\n')
  .map((line) => `    ${line.trim()}`)
  .join('\n')}
  </g>
</svg>
`;
fs.writeFileSync(path.join(here, 'AppIcon.icon/Assets/mark.svg'), layer);

// -- compile the recipe -----------------------------------------------------------------
const glass = path.join(here, 'glass');
fs.rmSync(glass, { recursive: true, force: true });
fs.mkdirSync(glass);
execFileSync('xcrun', [
  'actool', path.join(here, 'AppIcon.icon'),
  '--compile', glass,
  '--platform', 'macosx',
  '--minimum-deployment-target', '11.0',
  '--app-icon', 'AppIcon',
  '--include-all-app-icons',
  '--output-partial-info-plist', path.join(glass, 'partial.plist'),
  '--errors', '--warnings', '--output-format', 'human-readable-text',
]);

// -- derive the legacy artifacts --------------------------------------------------------
fs.copyFileSync(path.join(glass, 'AppIcon.icns'), path.join(here, 'icon.icns'));
execFileSync('sips', [
  '-s', 'format', 'png',
  '--resampleHeightWidth', '1024', '1024',
  path.join(glass, 'AppIcon.icns'),
  '--out', path.join(here, 'icon-1024.png'),
], { stdio: 'ignore' });

console.log('wrote glass/Assets.car, icon.icns, icon-1024.png');
