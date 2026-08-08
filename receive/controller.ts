import { LTDecoder } from "../shared/fountain.ts";
import { parseEnvelope, PREVIEW_MIME_TYPES } from "../shared/envelope.ts";
import { SESSION_STALL_TIMEOUT_MS, SOFT_ORIGINAL_LIMIT } from "../shared/limits.ts";
import { fnv1a, parseFrame, type FrameHeader } from "../shared/protocol.ts";
import { t, onLangChange } from "../shared/i18n.ts";

/** Overhead tipico LT per stimare i frame ancora necessari (spesso si completa prima). */
const OVERHEAD_EST = 1.12;
const OVERHEAD_OPTIMISTIC = 1.06;
const STATS_WINDOW_MS = 1600;
const STATS_TICK_MS = 200;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const CAMERA_GRANTED_KEY = "ot-camera-granted";

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let activeHeader: FrameHeader | null = null;
let startTs = 0;
let lastProgressTs = 0;
let captureGen = 0;
let done = false;
let running = false;
let paused = false;
/** Pausa automatica dopo tab/app in background: serve un tap su Riprendi per riaprire la camera. */
let bgPaused = false;
let statsTimer: number | null = null;
let objectUrl: string | null = null;
let finishMeta: { kib: number; sec: string } | null = null;
const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];
const progressSamples: { t: number; solved: number; frames: number; bytes: number }[] = [];
let lastRateLabel = "";
let lastEtaLabel = "";
/** EMA secondi rimanenti: scende in fretta, sale piano (evita “3 min” spuri). */
let etaEmaSec = 0;
const rejectedLargeSessions = new Set<string>();
const grab = document.createElement("canvas");
let frameId = 0;

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function sessionKey(header: FrameHeader): string {
  return [header.sessionId, header.k, header.blockLen, header.totalLen, header.payloadFnv].join(":");
}

function headersCompatible(a: FrameHeader, b: FrameHeader): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.k === b.k &&
    a.blockLen === b.blockLen &&
    a.totalLen === b.totalLen &&
    a.payloadFnv === b.payloadFnv
  );
}

function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function showRecvError(message: string | null, showFallback = false): void {
  const err = el("recv-error");
  const tips = el("recv-tips");
  if (err) {
    if (!message) {
      err.hidden = true;
      err.textContent = "";
    } else {
      err.hidden = false;
      err.textContent = message;
    }
  }
  if (tips) tips.hidden = !showFallback;
}

function resetProgressSamples(): void {
  progressSamples.length = 0;
  lastRateLabel = "";
  lastEtaLabel = "";
  etaEmaSec = 0;
}

function syncStatsVisibility(): void {
  const stats = document.querySelector("#xfer-progress .xfer-stats") as HTMLElement | null;
  if (stats) stats.hidden = !decoder || done;
}

function updateProgressUi(pct: number, rate: string, eta: string, doneBytes: number, leftBytes: number): void {
  const bar = el("bar");
  const pctEl = el("xfer-pct");
  if (bar) bar.style.width = `${pct.toFixed(1)}%`;
  if (pctEl) {
    if (running && !decoder && !done) pctEl.textContent = "…";
    else pctEl.textContent = `${Math.min(100, Math.round(pct))}%`;
  }
  setText("m-rate", rate);
  setText("m-eta", eta);
  setText("m-done", formatBytes(doneBytes));
  setText("m-left", formatBytes(leftBytes));
  updateXferState();
}

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) bytesPerSec = 0;
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KiB/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return lastEtaLabel || "…";
  if (seconds < 1.25) return "< 1 s";
  if (seconds < 90) return `${Math.ceil(seconds)} s`;
  if (seconds < 180) return `${Math.round(seconds / 5) * 5} s`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** Byte/s stimati dai QR decodificati negli ultimi `windowMs` (reattivo). */
function decodeWindowByteRate(now: number, blockLen: number, windowMs = 1000): number {
  let i = decodeTimes.length - 1;
  let count = 0;
  while (i >= 0 && decodeTimes[i]! >= now - windowMs) {
    count++;
    i--;
  }
  if (count <= 0) return 0;
  const oldest = decodeTimes[i + 1]!;
  const dt = Math.max(0.15, (now - oldest) / 1000);
  return (count * blockLen) / dt;
}

function smoothEta(rawSec: number): number {
  if (!Number.isFinite(rawSec) || rawSec < 0) return etaEmaSec;
  if (etaEmaSec <= 0) {
    etaEmaSec = rawSec;
    return etaEmaSec;
  }
  // Scende in fretta (si stava sovrastimando), sale piano (evita picchi).
  if (rawSec < etaEmaSec) etaEmaSec = 0.35 * etaEmaSec + 0.65 * rawSec;
  else etaEmaSec = 0.82 * etaEmaSec + 0.18 * rawSec;
  return etaEmaSec;
}

/**
 * Progresso/ETA per fountain code: i blocchi "solved" restano bassi a lungo e
 * poi salgono di colpo. L'ETA deve basarsi sui frame unici ricevuti e sul rate
 * recente, non su solved/elapsed (che produce stime di minuti fasulle).
 */
function refreshReceiveStats(): void {
  if (!running || done || !decoder || !activeHeader) return;

  const now = performance.now();
  const solved = decoder.solvedCount;
  const frames = decoder.framesNew;
  const blockLen = Math.max(1, decoder.blockLen);
  const total = Math.max(1, activeHeader.totalLen);
  const k = Math.max(1, decoder.k);
  const elapsed = Math.max(0.08, (now - startTs) / 1000);
  const targetFrames = k * OVERHEAD_EST;
  const optimisticTarget = k * OVERHEAD_OPTIMISTIC;

  const pctSolved = solved / k;
  const pctFrames = Math.min(1.05, frames / targetFrames);
  // I frame unici tracciano il lavoro reale; solved serve solo in coda.
  const pct = Math.min(99, Math.max(pctFrames, pctSolved) * 100);
  const doneBytes = Math.min(
    total,
    Math.max(pctSolved * total, Math.min(1, frames / targetFrames) * total),
  );
  const leftBytes = Math.max(0, total - doneBytes);

  if (!paused) {
    progressSamples.push({ t: now, solved, frames, bytes: doneBytes });
    while (progressSamples.length > 1 && progressSamples[0]!.t < now - STATS_WINDOW_MS) {
      progressSamples.shift();
    }
  }

  const avgByteRate = frames > 0 ? (frames * blockLen) / elapsed : 0;
  const avgFrameRate = frames > 0 ? frames / elapsed : 0;

  let winByteRate = 0;
  let winFrameRate = 0;
  let winSolveRate = 0;
  if (progressSamples.length >= 2) {
    const a = progressSamples[0]!;
    const b = progressSamples[progressSamples.length - 1]!;
    const dt = (b.t - a.t) / 1000;
    if (dt >= 0.25) {
      winByteRate = Math.max(0, (b.bytes - a.bytes) / dt);
      winFrameRate = Math.max(0, (b.frames - a.frames) / dt);
      winSolveRate = Math.max(0, (b.solved - a.solved) / dt);
    }
  }

  const liveByteRate = decodeWindowByteRate(now, blockLen, 900);
  // Velocità mostrata: segnale recente (non gonfiare con max su medie morte).
  const byteRate =
    winByteRate > 0
      ? Math.max(winByteRate, liveByteRate * 0.35)
      : Math.max(liveByteRate, avgByteRate);
  const frameRate = winFrameRate > 0.15 ? winFrameRate : Math.max(winFrameRate, avgFrameRate);

  let rateLabel = formatRate(byteRate);
  let etaLabel: string;

  const remainBlocks = Math.max(0, k - solved);
  const remainOptimistic = Math.max(0, optimisticTarget - frames);
  const remainConservative = Math.max(0, targetFrames - frames);

  if (remainBlocks <= 0 || pct >= 99 || frames >= optimisticTarget) {
    etaEmaSec = 0;
    etaLabel = "< 1 s";
  } else {
    const candidates: number[] = [];

    // 1) Frame unici mancanti / rate recente (stima primaria per LT)
    if (frameRate > 0.2) {
      candidates.push(remainOptimistic / frameRate);
      candidates.push(remainConservative / frameRate);
    }

    // 2) Byte rimanenti / throughput recente dei frame unici
    const uniqueByteRate = frameRate > 0.2 ? frameRate * blockLen : winByteRate;
    if (uniqueByteRate > 256 && leftBytes > 0) {
      candidates.push(leftBytes / uniqueByteRate);
    }

    // 3) Solve rate solo se sta davvero avanzando nella finestra recente
    //    (in coda al peeling è utile; a inizio sessione gonfia l'ETA).
    if (winSolveRate > 0.5 && pctSolved > 0.35) {
      candidates.push(remainBlocks / winSolveRate);
    }

    // 4) Estrapolazione dal progresso frame (ignora solved "piatto")
    if (pctFrames > 0.08 && elapsed > 0.5) {
      candidates.push((elapsed / pctFrames) * (1 - Math.min(0.99, pctFrames)));
    }

    let rawEta = 0;
    if (candidates.length > 0) {
      // Mediana: meno sensibile a un candidato fuori scala.
      candidates.sort((x, y) => x - y);
      rawEta = candidates[Math.floor(candidates.length / 2)]!;
      // Bias ottimistico: se il migliore è molto più basso, avvicinati a quello.
      const best = candidates[0]!;
      if (best > 0 && rawEta > best * 1.8) rawEta = best * 1.25 + rawEta * 0.2;
    } else if (lastEtaLabel && etaEmaSec > 0) {
      rawEta = etaEmaSec;
    }

    // Tetto: non mostrare più di ~2× il tempo già impiegato per la parte restante.
    if (pctFrames > 0.12 && elapsed > 0.8) {
      const cap = (elapsed / pctFrames) * (1 - Math.min(0.99, pctFrames)) * 2.2;
      if (rawEta > cap) rawEta = cap;
    }
    // Vicino al traguardo frame → secondi, non minuti.
    if (pctFrames > 0.85) rawEta = Math.min(rawEta, 8);
    else if (pctFrames > 0.7) rawEta = Math.min(rawEta, 20);

    if (rawEta > 0) {
      etaLabel = formatEta(smoothEta(rawEta));
    } else {
      etaLabel = lastEtaLabel || "…";
    }
  }

  if (!paused) {
    lastRateLabel = rateLabel;
    lastEtaLabel = etaLabel;
  } else {
    rateLabel = lastRateLabel || rateLabel;
    etaLabel = lastEtaLabel || etaLabel;
  }

  updateProgressUi(pct, rateLabel, etaLabel, doneBytes, leftBytes);
}

function updateXferState(): void {
  const state = el("xfer-state");
  const progressEl = el("xfer-progress");
  if (!state) return;
  if (bgPaused && paused && running) state.textContent = t("receive.backgroundResume");
  else if (paused && running) state.textContent = t("xfer.paused");
  else if (decoder && running) state.textContent = t("xfer.receiving");
  else if (running) state.textContent = t("receive.searchingShort");
  else state.textContent = "";
  if (progressEl && running && !done) progressEl.hidden = false;
  progressEl?.classList.toggle("is-searching", !!(running && !decoder && !done));
  progressEl?.classList.toggle("is-receiving", !!(running && decoder && !done));
  syncStatsVisibility();
}

function isStreamLive(): boolean {
  return !!stream?.getVideoTracks().some((track) => track.readyState === "live");
}

function markCameraGranted(): void {
  try {
    localStorage.setItem(CAMERA_GRANTED_KEY, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

function releaseCameraTracksOnly(): void {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  const video = el<HTMLVideoElement>("video");
  if (video) video.srcObject = null;
}

async function acquireCameraStream(captureWidth: number, captureFps: number): Promise<MediaStream> {
  if (isStreamLive() && stream) return stream;

  const preferred: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: captureWidth },
      height: { ideal: Math.round((captureWidth * 3) / 4) },
      frameRate: { ideal: captureFps },
    },
  };
  try {
    const next = await navigator.mediaDevices.getUserMedia(preferred);
    markCameraGranted();
    return next;
  } catch (preferredErr) {
    // Fallback minimo: evita OverconstrainedError su desktop / webcam frontale.
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      markCameraGranted();
      return next;
    } catch {
      throw preferredErr;
    }
  }
}

async function refreshPermHint(): Promise<void> {
  const hint = el("camera-perm-hint");
  if (!hint) return;
  if (running) {
    hint.hidden = true;
    return;
  }
  let show = false;
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    show = status.state === "prompt";
    status.onchange = () => {
      void refreshPermHint();
    };
  } catch {
    show = localStorage.getItem(CAMERA_GRANTED_KEY) !== "1";
  }
  hint.hidden = !show;
  if (show) hint.textContent = t("receive.permHint");
}

function syncPauseButtons(): void {
  const pauseBtn = el<HTMLButtonElement>("pause");
  const resumeBtn = el<HTMLButtonElement>("resume");
  const show = running && !done;
  if (pauseBtn) pauseBtn.hidden = !show || paused;
  if (resumeBtn) resumeBtn.hidden = !show || !paused;
}

function setReceiveWaitVisible(visible: boolean): void {
  const wait = el("receive-wait");
  if (wait) wait.hidden = !visible;
}

function cleanupResources(): void {
  captureGen++;
  running = false;
  paused = false;
  bgPaused = false;
  syncPauseButtons();
  releaseCameraTracksOnly();
  for (const worker of workers) worker.terminate();
  workers.length = 0;
  busy.length = 0;
  if (statsTimer !== null) {
    window.clearInterval(statsTimer);
    statsTimer = null;
  }
  const cameraPanel = el("camera-panel");
  const cancelBtn = el<HTMLButtonElement>("cancel");
  if (cameraPanel) cameraPanel.hidden = true;
  if (cancelBtn) cancelBtn.hidden = true;
  void refreshPermHint();
}

function clearTransferState(): void {
  decoder = null;
  activeHeader = null;
  startTs = 0;
  lastProgressTs = 0;
  captureTimes.length = 0;
  decodeTimes.length = 0;
  resetProgressSamples();
  updateProgressUi(0, "…", "…", 0, 0);
  syncStatsVisibility();
}

function abortTransfer(message: string, fallback = false): void {
  done = true;
  cleanupResources();
  clearTransferState();
  setText("stats", "");
  showRecvError(message, fallback);
  setReceiveWaitVisible(true);
  const startBtn = el<HTMLButtonElement>("start");
  const resetBtn = el<HTMLButtonElement>("reset");
  const settings = el<HTMLDetailsElement>("settings");
  if (startBtn) startBtn.hidden = false;
  if (resetBtn) resetBtn.hidden = false;
  if (settings) settings.hidden = true;
}

function resetUi(): void {
  cleanupResources();
  clearTransferState();
  done = false;
  paused = false;
  finishMeta = null;
  rejectedLargeSessions.clear();
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  el("result")?.replaceChildren();
  const settings = el<HTMLDetailsElement>("settings");
  const startBtn = el<HTMLButtonElement>("start");
  const resetBtn = el<HTMLButtonElement>("reset");
  const cameraPanel = el("camera-panel");
  const progressEl = el("xfer-progress");
  if (settings) settings.hidden = true;
  if (startBtn) startBtn.hidden = false;
  if (resetBtn) resetBtn.hidden = true;
  if (cameraPanel) cameraPanel.hidden = true;
  if (progressEl) progressEl.hidden = true;
  setText("stats", "");
  showRecvError(null, false);
  setReceiveWaitVisible(true);
  updateXferState();
  syncPauseButtons();
}

async function start(): Promise<void> {
  if (running) return;
  const stats = el("stats");
  const startBtn = el<HTMLButtonElement>("start");
  const cancelBtn = el<HTMLButtonElement>("cancel");
  const resetBtn = el<HTMLButtonElement>("reset");
  const settings = el<HTMLDetailsElement>("settings");
  const cameraPanel = el("camera-panel");
  const video = el<HTMLVideoElement>("video");
  if (!startBtn || !cancelBtn || !settings || !cameraPanel || !video) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    showRecvError(t("receive.secureError"), true);
    return;
  }

  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    if (status.state === "denied") {
      showRecvError(t("receive.deniedHelp"), true);
      return;
    }
  } catch {
    /* Permissions API non disponibile (es. iOS Safari): si procede con getUserMedia. */
  }

  clearTransferState();
  done = false;
  bgPaused = false;
  showRecvError(null, false);
  el("result")?.replaceChildren();
  const captureWidth = Number(el<HTMLSelectElement>("cfg-width").value);
  const captureFps = Number(el<HTMLSelectElement>("cfg-capfps").value);
  const workerCount = Number(el<HTMLSelectElement>("cfg-workers").value);
  settings.hidden = true;
  startBtn.hidden = true;
  setReceiveWaitVisible(false);
  if (resetBtn) resetBtn.hidden = true;
  cancelBtn.hidden = false;
  syncPauseButtons();
  cameraPanel.hidden = false;
  running = true;
  void refreshPermHint();
  const startAttempt = ++captureGen;
  try {
    stream = await acquireCameraStream(captureWidth, captureFps);
  } catch (err) {
    cleanupResources();
    const msg = err instanceof Error ? err.message : String(err);
    const denied = /NotAllowedError|Permission denied|PermissionDismissed/i.test(msg);
    showRecvError(denied ? t("receive.deniedHelp") : t("receive.cameraError", { msg }), true);
    startBtn.hidden = false;
    settings.hidden = true;
    setReceiveWaitVisible(true);
    return;
  }
  if (!running || startAttempt !== captureGen) {
    cleanupResources();
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  if (stats) {
    stats.hidden = true;
    stats.textContent = "";
  }
  const progressEl = el("xfer-progress");
  if (progressEl) progressEl.hidden = false;
  resetProgressSamples();
  updateProgressUi(0, "…", "…", 0, 0);
  syncPauseButtons();
  updateXferState();

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e: MessageEvent) => {
      const { id, bytes, error } = e.data as {
        id: number;
        bytes: Uint8Array | null;
        error?: string;
      };
      if (error) {
        abortTransfer(`✗ ${t("receive.workerError", { msg: error })}`);
        return;
      }
      if (id === -1) return;
      busy[slot] = false;
      if (bytes) onDecoded(bytes);
    };
    w.onerror = (event) => abortTransfer(`✗ ${t("receive.workerError", { msg: event.message })}`);
    workers.push(w);
    busy.push(false);
  }

  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = window.setInterval(updateStats, STATS_TICK_MS);
  void (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
    .wakeLock?.request("screen")
    .catch(() => undefined);
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number): void {
  // Non interrompere il loop in pausa: altrimenti Riprendi non riparte in modo affidabile.
  if (done || gen !== captureGen || !running) return;
  const video = el<HTMLVideoElement>("video") as VideoRVFC;
  if (!video) return;
  const next = () => {
    if (done || gen !== captureGen || !running) return;
    if (!paused) captureFrame();
    scheduleFrame(gen);
  };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

function captureFrame(): void {
  if (paused) return;
  const video = el<HTMLVideoElement>("video");
  if (!video) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return;
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  busy[slot] = true;
  workers[slot]!.postMessage({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [img.data.buffer]);
}

function onDecoded(bytes: Uint8Array): void {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done || !running) return;
  const { header, block } = parsed;

  if (activeHeader?.sessionId === header.sessionId && !headersCompatible(activeHeader, header)) {
    return;
  }

  if (!decoder || activeHeader?.sessionId !== header.sessionId) {
    const key = sessionKey(header);
    if (rejectedLargeSessions.has(key)) return;
    if (
      header.totalLen > SOFT_ORIGINAL_LIMIT &&
      !window.confirm(t("receive.largeConfirm", { size: (header.totalLen / 1024 / 1024).toFixed(1) }))
    ) {
      rejectedLargeSessions.add(key);
      setText("stats", t("receive.largeDeclined"));
      return;
    }
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    activeHeader = { ...header };
    startTs = performance.now();
    lastProgressTs = startTs;
    resetProgressSamples();
    const progressEl = el("xfer-progress");
    if (progressEl) progressEl.hidden = false;
    syncPauseButtons();
    syncStatsVisibility();
  }
  if (!decoder || !activeHeader) return;

  const before = decoder.framesNew;
  const solvedBefore = decoder.solvedCount;
  decoder.addFrame(header.seq, block);
  if (decoder.framesNew > before || decoder.solvedCount > solvedBefore) {
    lastProgressTs = performance.now();
  }
  refreshReceiveStats();

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    done = true;
    void finish(payload, seconds, activeHeader);
  }
}

async function finish(payload: Uint8Array, seconds: number, header: FrameHeader): Promise<void> {
  if (fnv1a(payload) !== header.payloadFnv) {
    showIntegrityError(t("receive.integrity.fnv"));
    return;
  }
  cleanupResources();
  const cameraPanel = el("camera-panel");
  if (cameraPanel) cameraPanel.hidden = true;
  const unpacked = await parseEnvelope(payload);
  if (!unpacked) {
    showIntegrityError(t("receive.integrity.envelope"));
    return;
  }

  updateProgressUi(100, lastRateLabel || "…", "0 s", unpacked.file.length, 0);
  syncStatsVisibility();
  const kib = Math.round(unpacked.file.length / 1024);
  finishMeta = { kib, sec: seconds.toFixed(1) };
  setText("stats", "");
  const result = el("result");
  if (!result) return;
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = t("receive.done");
  const meta = document.createElement("p");
  meta.className = "result-meta";
  meta.textContent = t("receive.statsShort", finishMeta);
  const safeMime = PREVIEW_MIME_TYPES.has(unpacked.mime)
    ? unpacked.mime
    : "application/octet-stream";
  objectUrl = URL.createObjectURL(new Blob([unpacked.file as BlobPart], { type: safeMime }));
  const download = document.createElement("a");
  download.className = "download";
  download.href = objectUrl;
  download.download = unpacked.filename;
  download.textContent = t("receive.save", { name: unpacked.filename });
  result.append(heading, meta, download);
  if (PREVIEW_MIME_TYPES.has(unpacked.mime)) {
    const image = document.createElement("img");
    image.className = "received";
    image.src = objectUrl;
    image.alt = t("receive.previewAlt", { name: unpacked.filename });
    result.append(image);
  }
  const resetBtn = el<HTMLButtonElement>("reset");
  if (resetBtn) resetBtn.hidden = false;
}

function showIntegrityError(message: string): void {
  done = true;
  cleanupResources();
  clearTransferState();
  setText("stats", "");
  showRecvError(t("receive.integrity.title", { msg: message }), true);
  const result = el("result");
  if (result) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = t("receive.integrity.banner");
    result.replaceChildren(error);
  }
  const startBtn = el<HTMLButtonElement>("start");
  const resetBtn = el<HTMLButtonElement>("reset");
  const settings = el<HTMLDetailsElement>("settings");
  if (startBtn) startBtn.hidden = false;
  if (resetBtn) resetBtn.hidden = false;
  if (settings) settings.hidden = true;
  setReceiveWaitVisible(true);
}

function updateStats(): void {
  if (done || !running) return;
  const now = performance.now();
  while (captureTimes.length > 0 && captureTimes[0]! < now - 2000) captureTimes.shift();
  while (decodeTimes.length > 0 && decodeTimes[0]! < now - 2000) decodeTimes.shift();
  if (decoder && activeHeader && !paused && now - lastProgressTs > SESSION_STALL_TIMEOUT_MS) {
    abortTransfer(t("receive.timeout"), true);
    return;
  }
  if (decoder && activeHeader) refreshReceiveStats();
  else updateXferState();
  setText("stats", "");
}

function onVisibility(): void {
  if (document.hidden) {
    if (running && !done) {
      // Non abortire: su mobile ogni ritorno forzava Reset → nuovo dialogo permesso.
      bgPaused = true;
      paused = true;
      releaseCameraTracksOnly();
      syncPauseButtons();
      updateXferState();
      refreshReceiveStats();
    }
    return;
  }
  if (bgPaused && running && !done) {
    syncPauseButtons();
    updateXferState();
  }
}

function onPageHide(ev: PageTransitionEvent): void {
  if (ev.persisted) {
    if (running && !done) {
      bgPaused = true;
      paused = true;
      releaseCameraTracksOnly();
    }
    return;
  }
  cleanupResources();
}

function onPauseClick(): void {
  if (!running || done || paused) return;
  paused = true;
  bgPaused = false;
  syncPauseButtons();
  refreshReceiveStats();
  updateXferState();
}

async function onResumeClick(): Promise<void> {
  if (!running || done || !paused) return;
  if (!isStreamLive()) {
    const captureWidth = Number(el<HTMLSelectElement>("cfg-width").value);
    const captureFps = Number(el<HTMLSelectElement>("cfg-capfps").value);
    const video = el<HTMLVideoElement>("video");
    try {
      stream = await acquireCameraStream(captureWidth, captureFps);
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showRecvError(t("receive.cameraError", { msg }), true);
      return;
    }
  }
  bgPaused = false;
  paused = false;
  showRecvError(null, false);
  lastProgressTs = performance.now();
  resetProgressSamples();
  syncPauseButtons();
  refreshReceiveStats();
  updateXferState();
  // Il loop resta attivo durante la pausa; forza un tick subito per riprendere.
  if (!done && running) captureFrame();
}

function onStartClick(): void {
  void start();
}
function onCancelClick(): void {
  abortTransfer(t("receive.cancelled"), false);
}
function onResetClick(): void {
  resetUi();
}

let langWired = false;

export function mountReceive(): void {
  el<HTMLButtonElement>("start")?.addEventListener("click", onStartClick);
  el<HTMLButtonElement>("pause")?.addEventListener("click", onPauseClick);
  el<HTMLButtonElement>("resume")?.addEventListener("click", onResumeClick);
  el<HTMLButtonElement>("cancel")?.addEventListener("click", onCancelClick);
  el<HTMLButtonElement>("reset")?.addEventListener("click", onResetClick);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  if (!langWired) {
    langWired = true;
    onLangChange(() => {
      if (finishMeta) {
        const meta = document.querySelector(".result-meta");
        if (meta) meta.textContent = t("receive.statsShort", finishMeta);
      }
      updateXferState();
      void refreshPermHint();
    });
  }
  resetUi();
  void refreshPermHint();
}

export function unmountReceive(): void {
  el<HTMLButtonElement>("start")?.removeEventListener("click", onStartClick);
  el<HTMLButtonElement>("pause")?.removeEventListener("click", onPauseClick);
  el<HTMLButtonElement>("resume")?.removeEventListener("click", onResumeClick);
  el<HTMLButtonElement>("cancel")?.removeEventListener("click", onCancelClick);
  el<HTMLButtonElement>("reset")?.removeEventListener("click", onResetClick);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onPageHide);
  cleanupResources();
  clearTransferState();
}
