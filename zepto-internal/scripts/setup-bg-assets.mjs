#!/usr/bin/env node
// Populates the two asset trees the background-removal engine loads at runtime:
//
//   public/vendor/  onnxruntime-web's WASM binaries + their JS glue. COPIED, because they must
//                   stay byte-matched to the installed onnxruntime-web version — a stale copy
//                   against a newer library fails with opaque WASM errors.
//   public/models/  ONNX weights in HuggingFace layout (<org>/<name>/onnx/…). COPIED from the
//                   bg-remover prototype when it is present next to this repo (so the suite is
//                   fully self-contained), downloaded from HuggingFace otherwise. Pass --link
//                   to symlink instead of copying and save the ~850 MB of duplication.
//
// Both trees are gitignored. Run: pnpm setup:bg

import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')
const PROTOTYPE_MODELS = path.resolve(ROOT, '../../bg-remover/static/models')

const COPY = !process.argv.includes('--link')

// Repo id -> the ONNX filename transformers.js resolves for that model's dtype
// (fp32 -> model.onnx, fp16 -> model_fp16.onnx). Config JSON sits at the repo root.
const MODELS = [
  { repo: 'briaai/RMBG-1.4', onnx: 'model_fp16.onnx' },
  { repo: 'onnx-community/BiRefNet_512x512-ONNX', onnx: 'model_fp16.onnx' },
  { repo: 'onnx-community/BEN2-ONNX', onnx: 'model_fp16.onnx' },
  { repo: 'Xenova/modnet', onnx: 'model_fp16.onnx' },
]
const CONFIGS = ['config.json', 'preprocessor_config.json']

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function resolveOrtDist() {
  // onnxruntime-web is a transitive dep of @huggingface/transformers, so under pnpm it is not at
  // node_modules/onnxruntime-web. Resolve it from the *realpath* of the library that depends on
  // it — resolving from the symlink walks up the wrong tree and finds nothing. Its package.json
  // is not in the exports map, but the WASM binaries are, so resolve one of those and take its
  // directory.
  const { createRequire } = await import('node:module')
  const entry = path.join(ROOT, 'node_modules/@huggingface/transformers/package.json')
  const require = createRequire(await fs.realpath(entry))
  const dir = path.dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'))
  const { version } = JSON.parse(await fs.readFile(path.join(dir, '..', 'package.json'), 'utf8'))
  return { dir, version }
}

async function setupVendor() {
  const { dir, version } = await resolveOrtDist()
  const dest = path.join(PUBLIC, 'vendor')
  await fs.mkdir(dest, { recursive: true })

  // The threaded WASM builds plus their glue. ORT picks a variant at runtime based on the
  // backend and browser capabilities, and each .wasm must sit beside its own .mjs.
  const names = (await fs.readdir(dir)).filter(
    (f) => f.startsWith('ort-wasm') && (f.endsWith('.wasm') || f.endsWith('.mjs'))
  )
  let bytes = 0
  for (const name of names) {
    await fs.copyFile(path.join(dir, name), path.join(dest, name))
    bytes += (await fs.stat(path.join(dir, name))).size
  }
  await fs.writeFile(
    path.join(dest, 'VERSION'),
    `onnxruntime-web@${version}\ncopied by scripts/setup-bg-assets.mjs\n`
  )
  console.log(`vendor: ${names.length} files, ${(bytes / 1e6).toFixed(0)} MB (onnxruntime-web@${version})`)
}

async function downloadTo(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await pipeline(res.body, createWriteStream(dest))
}

async function setupModels() {
  const dest = path.join(PUBLIC, 'models')
  await fs.mkdir(dest, { recursive: true })

  const haveLocal = await exists(PROTOTYPE_MODELS)
  for (const { repo, onnx } of MODELS) {
    const [org, name] = repo.split('/')
    const target = path.join(dest, org, name)
    // A symlink from an earlier --link run satisfies the exists() check, but in copy mode it
    // must be replaced — the point of copying is surviving the prototype folder going away.
    const isLink = await fs
      .lstat(target)
      .then((s) => s.isSymbolicLink())
      .catch(() => false)
    if (!(COPY && isLink) && (await exists(path.join(target, 'onnx', onnx)))) {
      console.log(`models: ${repo} already present`)
      continue
    }

    const source = path.join(PROTOTYPE_MODELS, org, name)
    if (haveLocal && (await exists(path.join(source, 'onnx', onnx)))) {
      await fs.mkdir(path.join(dest, org), { recursive: true })
      await fs.rm(target, { recursive: true, force: true })
      if (COPY) {
        await fs.cp(source, target, { recursive: true })
        console.log(`models: ${repo} copied from prototype`)
      } else {
        await fs.symlink(source, target, 'dir')
        console.log(`models: ${repo} symlinked to prototype`)
      }
      continue
    }

    console.log(`models: ${repo} downloading from HuggingFace…`)
    const base = `https://huggingface.co/${repo}/resolve/main`
    for (const cfg of CONFIGS) {
      try {
        await downloadTo(`${base}/${cfg}`, path.join(target, cfg))
      } catch (e) {
        // MODNet and friends do not all ship both config files.
        console.log(`  (skipped ${cfg}: ${e.message})`)
      }
    }
    await downloadTo(`${base}/onnx/${onnx}`, path.join(target, 'onnx', onnx))
    console.log(`models: ${repo} downloaded`)
  }
}

await setupVendor()
await setupModels()
console.log('\nDone. public/vendor and public/models are gitignored.')
