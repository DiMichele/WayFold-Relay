/** Center crop of an RGBA buffer. Used to enlarge the QR when the lens is slightly soft. */
export function cropRgbaCenter(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  ratio = 0.58,
): { data: Uint8ClampedArray; width: number; height: number } {
  const r = Math.min(0.95, Math.max(0.3, ratio));
  const cw = Math.max(16, Math.floor(width * r));
  const ch = Math.max(16, Math.floor(height * r));
  const sx = Math.floor((width - cw) / 2);
  const sy = Math.floor((height - ch) / 2);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcOff = ((sy + y) * width + sx) * 4;
    out.set(data.subarray(srcOff, srcOff + cw * 4), y * cw * 4);
  }
  return { data: out, width: cw, height: ch };
}
