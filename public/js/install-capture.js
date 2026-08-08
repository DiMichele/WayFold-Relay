/** Cattura beforeinstallprompt prima dei moduli ES. */
window.__wfBip = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__wfBip = e;
  window.dispatchEvent(new Event("wf:installready"));
});
