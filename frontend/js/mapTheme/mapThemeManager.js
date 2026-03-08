const STORAGE_KEY = "ogid-map-theme";

function readStorage() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeStorage(payload) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage failures
  }
}

export class MapThemeManager {
  constructor(themeConfig = {}) {
    this.configure(themeConfig);
    this.subscribers = new Set();
  }

  configure(themeConfig = {}) {
    this.themeConfig = themeConfig;
    const saved = readStorage();
    const defaultProvider = themeConfig.rules?.defaultProvider || "PMTiles";
    const lastThemeByProvider = {
      ...(themeConfig.rules?.defaultThemeByProvider || {}),
      ...(saved.lastThemeByProvider || {})
    };
    this.selection = {
      provider: saved.provider || defaultProvider,
      lastThemeByProvider
    };
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    listener(this.getSelection());
    return () => this.subscribers.delete(listener);
  }

  emit() {
    const snapshot = this.getSelection();
    writeStorage(snapshot);
    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }
  }

  getSelection() {
    const provider = this.selection.provider;
    return {
      provider,
      theme: this.selection.lastThemeByProvider[provider],
      lastThemeByProvider: { ...this.selection.lastThemeByProvider }
    };
  }

  getProviders() {
    return this.themeConfig.providers || [];
  }

  getThemesForProvider(providerId) {
    return this.getProviders().find((provider) => provider.id === providerId)?.themes || [];
  }

  setProvider(providerId) {
    if (!providerId) {
      return;
    }
    const themes = this.getThemesForProvider(providerId);
    const currentTheme = this.selection.lastThemeByProvider[providerId];
    if (!currentTheme && themes[0]) {
      this.selection.lastThemeByProvider[providerId] = themes[0].id;
    }
    this.selection.provider = providerId;
    this.emit();
  }

  setTheme(themeId) {
    const provider = this.selection.provider;
    if (!provider || !themeId) {
      return;
    }
    this.selection.lastThemeByProvider[provider] = themeId;
    this.emit();
  }

  resolveSpriteMode(providerId, themeId) {
    return this.themeConfig.rules?.spriteByTheme?.[`${providerId}:${themeId}`] || "dark";
  }

  isDark(providerId, themeId) {
    return this.resolveSpriteMode(providerId, themeId) === "dark";
  }

  getOverlayStyle(selection = this.getSelection()) {
    const dark = this.isDark(selection.provider, selection.theme);
    return {
      markerOpacity: dark ? 0.82 : 0.62,
      haloOpacity: dark ? 0.14 : 0.08,
      lineOpacity: dark ? 0.7 : 0.46
    };
  }

  resolveFallback(selection = this.getSelection()) {
    const fallback = this.themeConfig.rules?.fallback || {};
    if (selection.provider !== fallback.fromProvider) {
      return selection;
    }

    const provider = fallback.toProvider || "OpenFreeMap";
    const theme = fallback.themeMap?.[selection.theme] || this.themeConfig.rules?.defaultThemeByProvider?.[provider] || "Dark";
    return {
      provider,
      theme
    };
  }
}
