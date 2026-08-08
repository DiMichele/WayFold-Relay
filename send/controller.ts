import QRCode from "qrcode";
import { packEnvelope, type PackedEnvelope } from "../shared/envelope.ts";
import { LTEncoder } from "../shared/fountain.ts";
import { MAX_BLOCKS, MAX_ORIGINAL_FILE_LEN, SOFT_ORIGINAL_LIMIT } from "../shared/limits.ts";
import {
  HEADER_LEN,
  createSessionId,
  fnv1a,
  packFrame,
  type FrameHeader,
} from "../shared/protocol.ts";
import { t, onLangChange } from "../shared/i18n.ts";
import { zipFiles } from "../shared/zip.ts";

const MARGIN = 4;
const LOOKAHEAD = 3;

let generation = 0;
let lastStatusParams: Record<string, string | number> | null = null;
let langWired = false;
const payloadCache = new WeakMap<File, Promise<PackedEnvelope>>();
const largeApproved = new WeakSet<File>();
let preparedFile: File | null = null;
let selectedCount = 0;

let paused = false;
let streamActive = false;
let navSuspended = false;
let pausedBeforeNav = false;
let dropWired = false;
let controlsWired = false;
let pagehideWired = false;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function showSendError(message: string | null): void {
  const box = el("send-error");
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function updateFileDisplay(file: File | undefined, count = 0): void {
  const fileNameEl = el("file-name");
  const fileSizeEl = el("file-size");
  const zone = el("drop-zone");
  if (fileNameEl) {
    if (!file) fileNameEl.textContent = t("send.fileEmpty");
    else if (count > 1) fileNameEl.textContent = t("send.fileMulti", { count, name: file.name });
    else fileNameEl.textContent = file.name;
    fileNameEl.removeAttribute("data-i18n");
  }
  if (fileSizeEl) {
    if (file && file.size > 0) {
      fileSizeEl.hidden = false;
      fileSizeEl.textContent = t("send.fileSize", { size: formatBytes(file.size) });
    } else {
      fileSizeEl.hidden = true;
      fileSizeEl.textContent = "";
    }
  }
  zone?.classList.toggle("has-file", !!file);
}

function setStreamingUi(active: boolean): void {
  const qrStage = el("qr-stage");
  const qrPlaceholder = el("qr-placeholder");
  if (qrStage) {
    qrStage.hidden = !active;
    qrStage.setAttribute("aria-hidden", active ? "false" : "true");
  }
  if (qrPlaceholder) qrPlaceholder.hidden = active;
}

function setWorkspaceXfer(active: boolean): void {
  document.querySelector("#view-send .workspace")?.classList.toggle("is-xfer", active);
}

function setXferChrome(visible: boolean): void {
  const panel = el("send-xfer");
  const controls = el("send-controls");
  const zone = el("drop-zone");
  if (panel) panel.hidden = !visible;
  if (controls) controls.hidden = !visible;
  if (zone) zone.hidden = visible;
  setWorkspaceXfer(visible);
}

function syncPauseButtons(): void {
  const pauseBtn = el<HTMLButtonElement>("send-pause");
  const resumeBtn = el<HTMLButtonElement>("send-resume");
  if (!pauseBtn || !resumeBtn) return;
  if (!streamActive) {
    pauseBtn.hidden = true;
    resumeBtn.hidden = true;
    return;
  }
  pauseBtn.hidden = paused;
  resumeBtn.hidden = !paused;
}

function updateSendXferUi(): void {
  const stateEl = el("send-state");
  const liveEl = el("send-live");
  if (stateEl) {
    if (!streamActive) stateEl.textContent = "";
    else stateEl.textContent = paused ? t("xfer.paused") : t("xfer.streaming");
  }
  if (liveEl) liveEl.hidden = !streamActive || paused;
  syncPauseButtons();
}

function setIdleStatus(): void {
  lastStatusParams = null;
  paused = false;
  streamActive = false;
  navSuspended = false;
  pausedBeforeNav = false;
  preparedFile = null;
  selectedCount = 0;
  setXferChrome(false);
  syncPauseButtons();
  showSendError(null);
  const specs = el("specs");
  const cfgPayload = el<HTMLInputElement>("cfg-payload");
  if (specs) {
    specs.hidden = true;
    specs.textContent = "";
  }
  const file = cfgPayload?.files?.[0];
  updateFileDisplay(file, cfgPayload?.files?.length ?? 0);
  setStreamingUi(!!file);
  updateSendXferUi();
}

function setStreamingStatus(params: Record<string, string | number>): void {
  // Keep params for i18n refresh only — never show gzip/fps technical line.
  lastStatusParams = params;
  const specs = el("specs");
  if (specs) {
    specs.hidden = true;
    specs.textContent = "";
  }
}

function setPreparingStatus(message: string): void {
  const stateEl = el("send-state");
  const panel = el("send-xfer");
  if (panel) panel.hidden = false;
  if (stateEl) stateEl.textContent = message;
  const specs = el("specs");
  if (specs) {
    specs.hidden = true;
    specs.textContent = "";
  }
}

async function loadPayload(file: File): Promise<PackedEnvelope> {
  const hit = payloadCache.get(file);
  if (hit) return hit;
  const pending = file
    .arrayBuffer()
    .then((buffer) => packEnvelope(new Uint8Array(buffer), file.name || "received-file", file.type));
  payloadCache.set(file, pending);
  return pending;
}

function setPaused(next: boolean): void {
  if (!streamActive || navSuspended) return;
  paused = next;
  updateSendXferUi();
}

/** Sospende l’invio senza distruggere la sessione (cambio tab Invia/Ricevi). */
export function suspendSend(): void {
  if (!streamActive || navSuspended) return;
  navSuspended = true;
  pausedBeforeNav = paused;
  paused = true;
  updateSendXferUi();
}

/** Ripristina l’invio esattamente come prima della sospensione. */
export function resumeSend(): void {
  if (!navSuspended) return;
  navSuspended = false;
  paused = pausedBeforeNav;
  updateSendXferUi();
}

export function isSendStreaming(): boolean {
  return streamActive;
}

function cancelStream(): void {
  generation++;
  navSuspended = false;
  pausedBeforeNav = false;
  const cfgPayload = el<HTMLInputElement>("cfg-payload");
  if (cfgPayload) cfgPayload.value = "";
  setIdleStatus();
}

async function startStream(): Promise<void> {
  const gen = ++generation;
  paused = false;
  streamActive = false;
  navSuspended = false;
  pausedBeforeNav = false;
  setXferChrome(false);

  const canvas = el<HTMLCanvasElement>("qr");
  const cfgPayload = el<HTMLInputElement>("cfg-payload");
  const cfgFps = el<HTMLSelectElement>("cfg-fps");
  const cfgBytes = el<HTMLSelectElement>("cfg-bytes");
  const cfgEcc = el<HTMLSelectElement>("cfg-ecc");
  const cfgSize = el<HTMLInputElement>("cfg-size");
  if (!canvas || !cfgPayload || !cfgFps || !cfgBytes || !cfgEcc || !cfgSize) return;

  const list = cfgPayload.files ? Array.from(cfgPayload.files) : [];
  if (!list.length) {
    setIdleStatus();
    return;
  }
  showSendError(null);
  selectedCount = list.length;
  setPreparingStatus(list.length > 1 ? t("send.packing") : t("xfer.preparing"));
  let file: File;
  try {
    file = await zipFiles(list);
  } catch (error) {
    showSendError(error instanceof Error ? error.message : String(error));
    setXferChrome(false);
    setStreamingUi(false);
    return;
  }
  if (gen !== generation) return;
  preparedFile = file;
  updateFileDisplay(file, selectedCount);
  setStreamingUi(true);
  if (file.size === 0 || file.size > MAX_ORIGINAL_FILE_LEN) {
    lastStatusParams = null;
    const msg = t("send.sizeError", { max: MAX_ORIGINAL_FILE_LEN / 1024 / 1024 });
    showSendError(msg);
    setXferChrome(false);
    setStreamingUi(false);
    return;
  }
  if (
    file.size > SOFT_ORIGINAL_LIMIT &&
    !largeApproved.has(file) &&
    !window.confirm(t("send.largeConfirm", { size: (file.size / 1024 / 1024).toFixed(1) }))
  ) {
    lastStatusParams = null;
    showSendError(t("send.largeCancelled"));
    setXferChrome(false);
    setStreamingUi(false);
    return;
  }
  if (file.size > SOFT_ORIGINAL_LIMIT) largeApproved.add(file);
  lastStatusParams = null;
  setPreparingStatus(t("xfer.preparing"));
  let packed: PackedEnvelope;
  try {
    packed = await loadPayload(file);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    showSendError(msg);
    setXferChrome(false);
    setStreamingUi(false);
    return;
  }
  if (gen !== generation) return;
  const payload = packed.bytes;
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);

  const sessionId = createSessionId();
  const blockLen = frameBytes - HEADER_LEN;
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  if (encoder.k > MAX_BLOCKS) {
    lastStatusParams = null;
    const msg = t("send.blocksError", { k: encoder.k, max: MAX_BLOCKS });
    showSendError(msg);
    setXferChrome(false);
    setStreamingUi(false);
    return;
  }
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };

  let version: number | undefined;
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };

  const makeFrame = (): ImageData => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
      const saved = packed.originalLen - packed.wireFileLen;
      const compression =
        packed.compressed && saved > 0
          ? t("send.compression.gzip", { pct: ((saved / packed.originalLen) * 100).toFixed(1) })
          : t("send.compression.raw");
      setStreamingStatus({
        fps: txFps,
        fileMiB: (packed.originalLen / 1024 / 1024).toFixed(2),
        compression,
        payloadKiB: Math.ceil(payload.length / 1024),
      });
      streamActive = true;
      setXferChrome(true);
      updateSendXferUi();
    }
    const size = qr.modules.size;
    const data = qr.modules.data;
    const total = size + 2 * MARGIN;
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < size; y++) {
      const row = (y + MARGIN) * total + MARGIN;
      const src = y * size;
      for (let x = 0; x < size; x++) {
        if (data[src + x]) px[row + x] = 0xff000000;
      }
    }
    return img;
  };

  const pump = () => {
    if (gen !== generation) return;
    if (paused) {
      window.setTimeout(pump, 160);
      return;
    }
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    } catch (err) {
      showSendError(err instanceof Error ? err.message : String(err));
      return;
    }
    window.setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (paused) return;
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);
}

const onChange = () => void startStream();

function wireDropZone(): void {
  if (dropWired) return;
  dropWired = true;
  const zone = el("drop-zone");
  const input = el<HTMLInputElement>("cfg-payload");
  if (!zone || !input) return;

  const setDrag = (on: boolean) => zone.classList.toggle("is-dragover", on);

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    setDrag(true);
  });
  zone.addEventListener("dragleave", () => setDrag(false));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    setDrag(false);
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    const dt = new DataTransfer();
    for (const f of Array.from(files)) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function wireControls(): void {
  if (controlsWired) return;
  controlsWired = true;
  el<HTMLButtonElement>("send-pause")?.addEventListener("click", () => setPaused(true));
  el<HTMLButtonElement>("send-resume")?.addEventListener("click", () => setPaused(false));
  el<HTMLButtonElement>("send-stop")?.addEventListener("click", () => cancelStream());
}

export function mountSend(): void {
  const controls = ["cfg-payload", "cfg-fps", "cfg-bytes", "cfg-ecc", "cfg-size"];
  for (const id of controls) {
    document.getElementById(id)?.addEventListener("change", onChange);
  }
  wireDropZone();
  wireControls();
  if (!langWired) {
    langWired = true;
    onLangChange(() => {
      if (lastStatusParams) setStreamingStatus(lastStatusParams);
      else {
        const input = el<HTMLInputElement>("cfg-payload");
        updateFileDisplay(preparedFile ?? input?.files?.[0], selectedCount || input?.files?.length || 0);
      }
      updateSendXferUi();
    });
  }
  if (!pagehideWired) {
    pagehideWired = true;
    window.addEventListener("pagehide", () => {
      generation++;
      streamActive = false;
      navSuspended = false;
      paused = false;
    });
  }
  // Non resettare se c’è già una trasmissione (anche sospesa per navigazione).
  if (streamActive || navSuspended) {
    resumeSend();
    return;
  }
  setIdleStatus();
  void (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
    .wakeLock?.request("screen")
    .catch(() => undefined);
}

export function unmountSend(): void {
  // Soft-unmount: conserva la sessione QR se attiva.
  if (streamActive) {
    suspendSend();
    return;
  }
  generation++;
  const controls = ["cfg-payload", "cfg-fps", "cfg-bytes", "cfg-ecc", "cfg-size"];
  for (const id of controls) {
    document.getElementById(id)?.removeEventListener("change", onChange);
  }
  lastStatusParams = null;
  streamActive = false;
  paused = false;
  navSuspended = false;
}
