import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const templatePath = join(root, "scripts", "sw.template.js");
const excludedBasenames = new Set(["sw.js", "success.png", "success-2mb.png"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

const absoluteFiles = await walk(dist);
const relativeFiles = absoluteFiles
  .map((file) => relative(dist, file).split(sep).join("/"))
  .filter((file) => !file.endsWith(".map") && !excludedBasenames.has(file.split("/").at(-1)))
  .sort((a, b) => a.localeCompare(b, "en"));

const required = [
  ["WASM decoder", (file) => file.endsWith(".wasm")],
  ["decode worker", (file) => /(^|\/)worker-[^/]+\.js$/.test(file)],
  ["send page", (file) => file === "send/index.html"],
  ["receive page", (file) => file === "receive/index.html"],
  ["root manifest", (file) => file === "manifest.webmanifest"],
  ["send manifest", (file) => file === "send/manifest.webmanifest"],
  ["receive manifest", (file) => file === "receive/manifest.webmanifest"],
  ["pwa icon 192", (file) => file === "icons/icon-192.png"],
  ["favicon 32", (file) => file === "icons/favicon-32.png"],
];
for (const [label, predicate] of required) {
  if (!relativeFiles.some(predicate)) throw new Error(`Cannot generate service worker: missing ${label}`);
}

const urls = relativeFiles.map((file) => `/${file}`);
const manifestHash = createHash("sha256");
for (const file of relativeFiles) {
  const contentHash = createHash("sha256").update(await readFile(join(dist, file))).digest("hex");
  manifestHash.update(`${file}\0${contentHash}\n`);
}
const cacheName = `wayfold-relay-precache-${manifestHash.digest("hex").slice(0, 12)}`;

const template = await readFile(templatePath, "utf8");
const output = template
  .replace("__CACHE_NAME__", JSON.stringify(cacheName))
  .replace("__PRECACHE_URLS__", JSON.stringify(urls, null, 2));
if (output.includes("__CACHE_NAME__") || output.includes("__PRECACHE_URLS__")) {
  throw new Error("Service-worker template placeholders were not replaced");
}

await writeFile(join(dist, "sw.js"), output);
console.log(`Generated dist/sw.js (${cacheName}, ${urls.length} assets)`);
