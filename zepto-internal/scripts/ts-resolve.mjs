// Resolve hook so Node can import the app's own .ts modules directly.
//
// The app is bundler-resolved: `import { x } from './engine'` has no extension, and Node's ESM
// resolver requires one. Rather than duplicate app logic into scripts (which then drifts from
// the code it is supposed to measure), scripts register this hook and import the real module.
//
//   node --import ./scripts/ts-resolve.mjs scripts/whatever.mjs
//
// Type stripping itself is native in Node 22.6+; this only fixes specifier resolution.

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

if (!process.env.__TS_RESOLVE_REGISTERED) {
  process.env.__TS_RESOLVE_REGISTERED = '1';
  register(pathToFileURL(import.meta.filename));
}

const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, next) {
  // Bundlers import JSON with a bare specifier; Node requires an explicit type attribute.
  // Stamping it on the RESULT keeps the app's own import statements untouched (passing it
  // down through `next` is ignored — the attribute belongs to the resolution, not the call).
  if (specifier.endsWith('.json')) {
    const resolved = await next(specifier, context);
    return { ...resolved, importAttributes: { type: 'json' }, shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (e) {
    // Only relative/absolute specifiers get the extension sweep — a bare package name that
    // fails to resolve is a real missing dependency and must keep its own error.
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw e;
    for (const ext of CANDIDATES) {
      try {
        return await next(specifier + ext, context);
      } catch {}
    }
    throw e;
  }
}
