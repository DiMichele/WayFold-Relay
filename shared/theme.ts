const STORAGE_KEY = "ot-theme";

function themeColorFor(theme: "light" | "dark"): string {
  return theme === "light" ? "#F7F6F3" : "#141A1F";
}

function updateThemeColorMeta(theme: "light" | "dark"): void {
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.append(meta);
  }
  meta.setAttribute("content", themeColorFor(theme));
}

export function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeColorMeta(theme);
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  const moon = btn.querySelector(".icon-moon") as HTMLElement | null;
  const sun = btn.querySelector(".icon-sun") as HTMLElement | null;
  if (moon) moon.style.display = theme === "light" ? "none" : "";
  if (sun) sun.style.display = theme === "light" ? "" : "none";
}

export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ok */
  }
  const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const theme = saved === "light" || saved === "dark" ? saved : system;
  applyTheme(theme);

  document.getElementById("themeToggle")?.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ok */
    }
  });
}
