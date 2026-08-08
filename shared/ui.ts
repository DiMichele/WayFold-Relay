import {
  LANG_OPTIONS,
  applyStatic,
  emitLangChange,
  getLang,
  setLang,
  t,
  type Lang,
} from "./i18n.ts";
import { initTheme } from "./theme.ts";

const FLAG_CODES: Record<Lang, string> = {
  it: "IT",
  en: "GB",
  fr: "FR",
  es: "ES",
  de: "DE",
};

export function initChrome(): void {
  initTheme();
  initLangMenu();
  applyStatic();
}

function initLangMenu(): void {
  const toggle = document.getElementById("langToggle");
  const menu = document.getElementById("langMenu");
  if (!toggle || !menu) return;

  if (!menu.childElementCount) {
    for (const opt of LANG_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lang-opt";
      btn.dataset.lang = opt.id;
      btn.setAttribute("role", "option");
      btn.innerHTML = `<span class="lang-flag">${FLAG_CODES[opt.id]}</span><span>${opt.name}</span>`;
      menu.append(btn);
    }
  }

  const refresh = () => {
    const lang = getLang();
    const flag = document.getElementById("langFlag");
    if (flag) flag.textContent = FLAG_CODES[lang] ?? "IT";
    menu.querySelectorAll<HTMLButtonElement>(".lang-opt").forEach((el) => {
      const on = el.dataset.lang === lang;
      el.classList.toggle("on", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    });
    toggle.setAttribute("aria-label", t("lang.label"));
    toggle.setAttribute("aria-expanded", menu.classList.contains("open") ? "true" : "false");
  };

  document.addEventListener("click", () => {
    menu.classList.remove("open");
    refresh();
  });

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  menu.querySelectorAll<HTMLButtonElement>(".lang-opt").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const lang = el.dataset.lang as Lang | undefined;
      if (lang && lang !== getLang()) {
        setLang(lang);
        emitLangChange();
      }
      menu.classList.remove("open");
      refresh();
    });
  });

  refresh();
}
