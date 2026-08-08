/**
 * Crea WayFold-Relay-offline.zip nella root del progetto.
 * Richiede rete solo per scaricare Node portatile (una volta, in fase di build).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outZip = path.join(root, "WayFold-Relay-offline.zip");
const staging = path.join(root, ".offline-staging");
const NODE_VERSION = "v22.14.0";
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, name.name);
    const d = path.join(dest, name.name);
    if (name.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download fallito: ${url} (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function extractNodeZip(zipPath, destDir) {
  // Use PowerShell Expand-Archive on Windows
  fs.mkdirSync(destDir, { recursive: true });
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force"`,
    { stdio: "inherit" },
  );
  const inner = path.join(destDir, `node-${NODE_VERSION}-win-x64`);
  const nodeDest = path.join(destDir, "node");
  if (fs.existsSync(inner)) {
    fs.renameSync(inner, nodeDest);
  }
}

function main() {
  console.log("Build app…");
  execSync("npm run build", { cwd: root, stdio: "inherit" });

  console.log("Certificati HTTPS…");
  execSync("node offline/gen-cert.mjs", { cwd: root, stdio: "inherit", env: { ...process.env, NODE_PATH: path.join(root, "node_modules") } });

  rmrf(staging);
  const pkg = path.join(staging, "WayFold-Relay-offline");
  fs.mkdirSync(pkg, { recursive: true });

  console.log("Copia dist e offline…");
  copyDir(path.join(root, "dist"), path.join(pkg, "dist"));
  const offlinePkg = path.join(pkg, "offline");
  fs.mkdirSync(offlinePkg, { recursive: true });
  fs.mkdirSync(path.join(offlinePkg, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "offline", "serve.mjs"), path.join(offlinePkg, "serve.mjs"));
  fs.copyFileSync(path.join(root, "offline", "scripts", "start.ps1"), path.join(offlinePkg, "scripts", "start.ps1"));
  copyDir(path.join(root, "offline", "certs"), path.join(offlinePkg, "certs"));
  fs.copyFileSync(path.join(root, "offline", "LEGGIMI.txt"), path.join(pkg, "LEGGIMI.txt"));
  fs.copyFileSync(path.join(root, "offline", "Avvia-Relay.bat"), path.join(pkg, "Avvia-Relay.bat"));

  const nodeZip = path.join(staging, "node.zip");
  const nodeExtract = path.join(pkg, "_node_tmp");
  console.log(`Scarico Node portatile ${NODE_VERSION}…`);
  return download(NODE_URL, nodeZip)
    .then(() => extractNodeZip(nodeZip, nodeExtract))
    .then(() => {
      const inner = path.join(nodeExtract, "node");
      if (fs.existsSync(inner)) {
        copyDir(inner, path.join(pkg, "node"));
      }
      fs.rmSync(nodeExtract, { recursive: true, force: true });
      fs.unlinkSync(nodeZip);

      console.log("Crea zip…");
      if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${pkg.replace(/'/g, "''")}\\*' -DestinationPath '${outZip.replace(/'/g, "''")}' -CompressionLevel Optimal"`,
        { stdio: "inherit" },
      );
      rmrf(staging);
      const mb = (fs.statSync(outZip).size / 1024 / 1024).toFixed(1);
      console.log(`\nFatto: ${outZip} (${mb} MiB)`);
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
