// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { cropRgbaCenter } from "./image-crop.ts";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

const READ_OPTS = { formats: ["QRCode"] as ["QRCode"], maxNumberOfSymbols: 1 };

function toImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  const copy = new Uint8ClampedArray(data.length);
  copy.set(data);
  return new ImageData(copy, width, height);
}

async function decodeQr(img: ImageData): Promise<Uint8Array | null> {
  const results = await readBarcodes(img, READ_OPTS);
  const hit = results.find((x) => x.isValid && x.bytes.length > 0);
  return hit ? hit.bytes : null;
}

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h } = e.data as { id: number; buf: ArrayBuffer; w: number; h: number };
  try {
    const pixels = new Uint8ClampedArray(buf);
    let bytes = await decodeQr(toImageData(pixels, w, h));
    if (!bytes && w >= 80 && h >= 80) {
      const crop = cropRgbaCenter(pixels, w, h, 0.58);
      bytes = await decodeQr(toImageData(crop.data, crop.width, crop.height));
    }
    ctx.postMessage({ id, bytes });
  } catch {
    ctx.postMessage({ id, bytes: null });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .then(() => ctx.postMessage({ id: -1, bytes: null }))
  .catch((error: unknown) =>
    ctx.postMessage({
      id: -1,
      bytes: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
