/**
 * Service worker + install PWA (mobile only), allineato a wayfold.xyz:
 * - aggiornamenti SW in silenzio (niente banner “Aggiornamento disponibile”)
 * - prompt install solo su telefono/tablet, non su desktop
 */

declare global {
  interface Window {
    __wfBip?: BeforeInstallPromptEvent | null;
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "ot:pwa-install-dismissed";
const BIP_WAIT_MS = 2800;
const VISIBLE = "is-visible";

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installDismissed = false;
let installUiReady = false;
let guideFallbackReady = false;
let bipWaitTimer: number | null = null;
let silentUpdateScheduled = false;
let refreshing = false;

function adoptDeferredPrompt(): void {
  if (!deferredPrompt && window.__wfBip) deferredPrompt = window.__wfBip;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (/iPad|iPhone|iPod/i.test(navigator.userAgent)) return true;
  return navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.userAgent);
}

function isMobileInstallTarget(): boolean {
  if (/iPad|iPhone|iPod|Android/i.test(navigator.userAgent)) return true;
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

function shouldShowPwaUi(): boolean {
  return isMobileInstallTarget() && !isStandalone();
}

function readDismissed(): boolean {
  if (installDismissed) return true;
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function setBarVisible(el: HTMLElement | null, on: boolean): void {
  if (!el) return;
  el.classList.toggle(VISIBLE, on);
  el.hidden = !on;
}

function hideInstallBanner(): void {
  setBarVisible(document.getElementById("pwaInstall"), false);
}

function hideInstallGuide(): void {
  setBarVisible(document.getElementById("pwaInstallGuide"), false);
}

function showInstallBanner(): void {
  hideInstallGuide();
  setBarVisible(document.getElementById("pwaInstall"), true);
}

function showInstallGuide(): void {
  hideInstallBanner();
  const guide = document.getElementById("pwaInstallGuide");
  const iosSteps = document.getElementById("pwaInstallIosSteps");
  const fallback = document.getElementById("pwaInstallFallback");
  if (!guide) return;
  const useIos = isIos();
  if (iosSteps) iosSteps.hidden = !useIos;
  if (fallback) fallback.hidden = useIos;
  setBarVisible(guide, true);
}

function dismissInstallUi(): void {
  installDismissed = true;
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ok */
  }
  hideInstallBanner();
  hideInstallGuide();
}

function syncInstallUi(): void {
  if (!installUiReady || !shouldShowPwaUi() || readDismissed()) {
    hideInstallBanner();
    hideInstallGuide();
    return;
  }
  if (deferredPrompt) {
    if (bipWaitTimer) {
      window.clearTimeout(bipWaitTimer);
      bipWaitTimer = null;
    }
    showInstallBanner();
    return;
  }
  if (isIos() || guideFallbackReady) {
    showInstallGuide();
    return;
  }
  hideInstallBanner();
  hideInstallGuide();
}

function scheduleGuideFallback(): void {
  if (bipWaitTimer) window.clearTimeout(bipWaitTimer);
  if (!isMobileInstallTarget() || isIos()) {
    guideFallbackReady = true;
    syncInstallUi();
    return;
  }
  bipWaitTimer = window.setTimeout(() => {
    guideFallbackReady = true;
    syncInstallUi();
  }, BIP_WAIT_MS);
}

function initInstall(): void {
  document.getElementById("pwa-update")?.remove();

  if (!shouldShowPwaUi()) {
    hideInstallBanner();
    hideInstallGuide();
    return;
  }

  const installBtn = document.getElementById("pwaInstallBtn");
  if (!installBtn) return;

  document.getElementById("pwaInstallClose")?.addEventListener("click", dismissInstallUi);
  document.getElementById("pwaInstallGuideClose")?.addEventListener("click", dismissInstallUi);

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    window.__wfBip = null;
    dismissInstallUi();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    window.__wfBip = null;
    dismissInstallUi();
  });

  window.addEventListener("wf:installready", () => {
    adoptDeferredPrompt();
    syncInstallUi();
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    window.__wfBip = deferredPrompt;
    syncInstallUi();
  });

  installUiReady = true;
  adoptDeferredPrompt();
  scheduleGuideFallback();
  syncInstallUi();
}

function hasPendingUpdate(registration: ServiceWorkerRegistration): boolean {
  return !!(registration.waiting && navigator.serviceWorker.controller);
}

function applyUpdate(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting;
  if (!waiting) return;
  waiting.postMessage({ type: "SKIP_WAITING" });
  window.setTimeout(() => {
    if (!refreshing) {
      refreshing = true;
      location.reload();
    }
  }, 400);
}

function scheduleSilentUpdate(registration: ServiceWorkerRegistration): void {
  if (silentUpdateScheduled || !hasPendingUpdate(registration)) return;
  silentUpdateScheduled = true;
  // Solo quando il tab non è visibile: evita refresh autonomi che spezzano
  // beforeinstallprompt / installazione PWA su mobile.
  const run = () => {
    if (document.visibilityState !== "hidden") return;
    if (document.querySelector(".xfer-progress:not([hidden]), #camera-panel:not([hidden])")) return;
    applyUpdate(registration);
  };
  if (document.visibilityState === "hidden") {
    run();
    return;
  }
  document.addEventListener("visibilitychange", run);
}

async function initServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    location.reload();
  });

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (hasPendingUpdate(registration)) scheduleSilentUpdate(registration);
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && hasPendingUpdate(registration)) {
          scheduleSilentUpdate(registration);
        }
      });
    });
  } catch (error) {
    console.error("Service worker registration failed", error);
  }
}

/** @deprecated use initPwa — kept name for existing imports */
export async function registerServiceWorker(): Promise<void> {
  await initServiceWorker();
  initInstall();
}
