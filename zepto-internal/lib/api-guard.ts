// What every API route owes the machine it runs on: a bound on how much it will read, and a
// bound on where it will send money. Server-only — nothing here is imported by client code.

import { NextResponse } from 'next/server';

/** Thrown by readBodyCapped; carries the response the route should return. */
export class PayloadTooLarge extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Request body is larger than ${maxBytes / (1024 * 1024)} MB`);
    this.name = 'PayloadTooLarge';
    this.maxBytes = maxBytes;
  }
  response(): NextResponse {
    return NextResponse.json({ error: this.message }, { status: 413 });
  }
}

/**
 * The request body, or PayloadTooLarge. The App Router imposes no body limit of its own, so a
 * route that calls `req.arrayBuffer()` will buffer whatever it is sent — and this server sits on
 * the office network. The declared length is checked first for the cheap refusal; the body is
 * then read in chunks against the cap, because a client can omit or understate the length.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get('content-length'));
  if (declared > maxBytes) throw new PayloadTooLarge(maxBytes);
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  // One plain ArrayBuffer-backed view, which is what fetch bodies, fs writes and TextDecoder all
  // accept without a copy or a cast.
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The hosts an Azure image endpoint can legitimately live on. Anything else is not Azure. */
const AZURE_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com', '.cognitiveservices.azure.com'];

/**
 * Whether `endpoint` points at an Azure OpenAI resource. The generate route is bring-your-own-
 * endpoint by design — the user pastes their resource URL — but "any origin the caller names,
 * with the caller's key attached" is also a proxy anyone on the network can aim anywhere. The
 * resource host is the one part of that URL that has to be Azure's.
 */
export function isAzureImageEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}
