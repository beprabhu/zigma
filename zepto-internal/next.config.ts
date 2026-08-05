import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The background-removal engine runs ONNX models through onnxruntime-web's
  // multithreaded WASM backend, which needs SharedArrayBuffer. SharedArrayBuffer
  // is only exposed to cross-origin-isolated documents, which requires this exact
  // header pair on every response — the page, the WASM, and the worker scripts
  // ORT spawns. Without them ORT silently drops to single-threaded and the larger
  // models fail to allocate.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ]
  },
  // onnxruntime-node is a native binding pulled in by @huggingface/transformers'
  // node entrypoint. Nothing server-side imports the library, but keeping it
  // external stops the bundler from trying to trace the .node binary.
  serverExternalPackages: ["onnxruntime-node", "sharp"],
}

export default nextConfig
