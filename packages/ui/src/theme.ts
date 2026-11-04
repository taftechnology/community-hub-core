export const THEME_STORAGE_KEY = "community-hub.theme";

export type Theme = "light" | "dark";

function getStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function readStoredTheme(): Theme | null {
  try {
    const storage = getStorage();
    const value = storage?.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "dark") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = theme;
  }
  try {
    const storage = getStorage();
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage access might throw if cookies/storage are disabled or quota is exceeded.
  }
}

export function initialTheme(): Theme {
  const stored = readStoredTheme();
  if (stored) {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.dataset.theme = stored;
    }
    return stored;
  }
  return systemTheme();
}
