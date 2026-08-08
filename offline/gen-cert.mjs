import selfsigned from "selfsigned";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const certDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "certs");
fs.mkdirSync(certDir, { recursive: true });

const attrs = [{ name: "commonName", value: "WayFold Relay Local" }];
const pems = await selfsigned.generate(attrs, {
  days: 3650,
  keySize: 2048,
  algorithm: "sha256",
});

fs.writeFileSync(path.join(certDir, "key.pem"), pems.private);
fs.writeFileSync(path.join(certDir, "cert.pem"), pems.cert);
console.log("Certificati scritti in", certDir);
