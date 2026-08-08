import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public/icons");
const BG = { r: 18, g: 18, b: 20, alpha: 1 };

const candidates = [
  process.argv[2],
  join(out, "icon-source.png"),
  join(
    process.env.USERPROFILE || "",
    ".cursor/projects/c-Users-digen-Desktop-WayFold/assets/c__Users_digen_AppData_Roaming_Cursor_User_workspaceStorage_e704520970990fa22b8506a148f0226f_images_image-02f12fb1-2ac5-4716-b1f4-8a876c825d09.png",
  ),
].filter(Boolean);

const src = candidates.find((p) => existsSync(p));
if (!src) {
  console.error("Source icon not found");
  process.exit(1);
}

console.log("source", src);
if (src !== join(out, "icon-source.png")) {
  copyFileSync(src, join(out, "icon-source.png"));
}

const full = await sharp(src).rotate().metadata();
const w = full.width || 1024;
const h = full.height || 1024;
// Ritaglio centrato: rimuove il padding nero attorno allo squircle
const side = Math.min(w, h, Math.round(Math.min(w, h) * 0.86));
const left = Math.max(0, Math.round((w - side) / 2));
const top = Math.max(0, Math.round((h - side) / 2));

let cropped;
try {
  cropped = await sharp(src)
    .rotate()
    .extract({ left, top, width: side, height: side })
    .trim({ threshold: 28 })
    .png()
    .toBuffer();
} catch {
  cropped = await sharp(src).rotate().resize(1024, 1024, { fit: "cover" }).png().toBuffer();
}

const cm = await sharp(cropped).metadata();
console.log("cropped", cm.width, cm.height);

async function make(size, file, padRatio = 0) {
  const inner = Math.round(size * (1 - padRatio));
  const content = await sharp(cropped)
    .resize(inner, inner, { fit: "cover" })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: content, gravity: "centre" }])
    .png()
    .toFile(join(out, file));
}

await make(192, "icon-192.png");
await make(512, "icon-512.png");
await make(180, "apple-touch-icon.png");
await make(32, "favicon-32.png");
await make(16, "favicon-16.png");
await make(64, "icon.png");
// Maskable: full-bleed (Android applies its own shape). Safe zone ~20% pad.
await make(192, "icon-maskable-192.png", 0.2);
await make(512, "icon-maskable-512.png", 0.2);
await make(512, "icon-master.png");

console.log("icons ok →", out);
