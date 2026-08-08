# WayFold Relay

PWA dell’ecosistema WayFold per **trasferire file tra due dispositivi vicini** usando solo schermo e fotocamera: QR animati con *fountain codes*, senza upload su server e senza rete tra mittente e ricevente.

Produzione: [https://transfer.wayfold.xyz](https://transfer.wayfold.xyz)

## Sviluppo locale

**Requisiti:** Node.js ≥ 18.

```bash
cd apps/wayfold-relay
npm ci
npm run dev
```

- **Mittente** (ideale su PC): `https://localhost:5173/send/` — scegli il file, luminosità al massimo.
- **Ricevente** (telefono): URL di rete che stampa Vite, es. `https://<ip-lan>:5173/receive/` — accetta il certificato autofirmato, avvia la fotocamera.

Il dev server è **solo HTTPS** perché `getUserMedia` su telefono richiede un contesto sicuro.

```bash
npm run typecheck
npm test
npm run build          # output in dist/
npm run build:offline-zip   # WayFold-Relay-offline.zip (Windows, include Node portatile)
```

## Pacchetto offline (senza internet)

`npm run build:offline-zip` crea `WayFold-Relay-offline.zip` con app compilata, server HTTPS locale e Node portatile. Sul PC offline: estrai tutto, avvia `Avvia-Relay.bat`, segui `LEGGIMI.txt`.

## Deploy produzione

Nginx serve file statici da `/var/www/transfer/current`. Sul server Hetzner il checkout può essere la cartella standalone `/home/wayfold/apps/transfer` oppure, dopo migrazione al monorepo, `…/WayFold/apps/wayfold-relay`.

Dalla macchina con il sorgente aggiornato:

```bash
cd apps/wayfold-relay   # oppure /home/wayfold/apps/transfer
./redeploy.sh
```

Configurazione nginx di riferimento: [`deploy/nginx-transfer.conf`](deploy/nginx-transfer.conf).

## Struttura

| Percorso | Ruolo |
|----------|--------|
| `send/`, `receive/` | Pagine mittente e ricevente |
| `shared/` | Protocollo, UI, i18n, service worker |
| `public/` | Manifest PWA, icone, asset statici |
| `offline/` | Server HTTPS locale per uso senza rete |
| `scripts/` | Build, service worker, zip offline |

## Licenza

MIT — vedi [LICENSE](LICENSE). Basato su tecniche di trasferimento ottico open source (QR, fountain codes, zxing-wasm, node-qrcode).
