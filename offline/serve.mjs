import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(process.argv[2] || path.join(here, "..", "dist"));
const certDir = path.join(here, "certs");
const PORT = Number(process.env.RELAY_PORT || 8443);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function lanIpv4() {
  const out = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function safePath(urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0] || "/");
  if (p.endsWith("/")) p += "index.html";
  const rel = p.replace(/^\//, "").replace(/\\/g, "/");
  if (rel.includes("..")) return null;
  const file = path.normalize(path.join(distRoot, rel));
  const rootNorm = path.normalize(distRoot);
  if (!file.startsWith(rootNorm)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  const index = path.join(path.dirname(file), "index.html");
  if (fs.existsSync(index) && fs.statSync(index).isFile()) return index;
  return null;
}

function main() {
  if (!fs.existsSync(distRoot)) {
    console.error(`Cartella dist non trovata: ${distRoot}`);
    process.exit(1);
  }
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error("Certificati mancanti in offline/certs/. Ricostruisci il pacchetto offline.");
    process.exit(1);
  }

  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);

  https
    .createServer({ key, cert }, (req, res) => {
      const file = safePath(new URL(req.url || "/", "https://local").pathname);
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "no-cache");
      fs.createReadStream(file).pipe(res);
    })
    .listen(PORT, "0.0.0.0", () => {
      console.log("");
      console.log("WayFold Relay — server HTTPS locale (offline)");
      console.log("==========================================");
      console.log("");
      console.log("PC mittente (schermo con QR):");
      console.log(`  https://localhost:${PORT}/send/`);
      console.log("");
      console.log("Telefono ricevente (stessa rete del PC, senza internet):");
      const ips = lanIpv4();
      if (ips.length === 0) {
        console.log("  (collega Wi‑Fi o hotspot, poi riavvia se serve)");
      } else {
        for (const ip of ips) console.log(`  https://${ip}:${PORT}/receive/`);
      }
      console.log("");
      console.log("Prima visita: accetta l'avviso sul certificato (autofirmato).");
      console.log("Poi consenti la fotocamera sul telefono.");
      console.log("");
      console.log("Ctrl+C per uscire.");
      console.log("");
    });
}

main();
