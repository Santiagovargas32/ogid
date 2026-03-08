export const MAP_THEME_PROVIDERS = Object.freeze({
  PMTiles: Object.freeze({
    id: "PMTiles",
    label: "PMTiles",
    themes: Object.freeze([
      Object.freeze({ id: "Black", spriteMode: "dark", styleKey: "pmtiles-black" }),
      Object.freeze({ id: "Dark", spriteMode: "dark", styleKey: "pmtiles-dark" }),
      Object.freeze({ id: "Grayscale", spriteMode: "dark", styleKey: "pmtiles-grayscale" }),
      Object.freeze({ id: "Light", spriteMode: "light", styleKey: "pmtiles-light" }),
      Object.freeze({ id: "White", spriteMode: "light", styleKey: "pmtiles-white" })
    ])
  }),
  OpenFreeMap: Object.freeze({
    id: "OpenFreeMap",
    label: "OpenFreeMap",
    themes: Object.freeze([
      Object.freeze({ id: "Dark", spriteMode: "dark", styleKey: "openfreemap-dark" }),
      Object.freeze({ id: "Positron", spriteMode: "light", styleKey: "openfreemap-positron" })
    ])
  }),
  CARTO: Object.freeze({
    id: "CARTO",
    label: "CARTO",
    themes: Object.freeze([
      Object.freeze({ id: "Dark Matter", spriteMode: "dark", styleKey: "carto-dark-matter" }),
      Object.freeze({ id: "Voyager", spriteMode: "light", styleKey: "carto-voyager" }),
      Object.freeze({ id: "Positron", spriteMode: "light", styleKey: "carto-positron" })
    ])
  })
});

export const MAP_THEME_RULES = Object.freeze({
  defaultProvider: "PMTiles",
  defaultThemeByProvider: Object.freeze({
    PMTiles: "Dark",
    OpenFreeMap: "Dark",
    CARTO: "Dark Matter"
  }),
  spriteByTheme: Object.freeze({
    "PMTiles:Black": "dark",
    "PMTiles:Dark": "dark",
    "PMTiles:Grayscale": "dark",
    "PMTiles:Light": "light",
    "PMTiles:White": "light",
    "OpenFreeMap:Dark": "dark",
    "OpenFreeMap:Positron": "light",
    "CARTO:Dark Matter": "dark",
    "CARTO:Voyager": "light",
    "CARTO:Positron": "light"
  }),
  fallback: Object.freeze({
    errorThreshold: 2,
    intervalMs: 10_000,
    fromProvider: "PMTiles",
    toProvider: "OpenFreeMap",
    themeMap: Object.freeze({
      Light: "Positron",
      White: "Positron",
      Black: "Dark",
      Dark: "Dark",
      Grayscale: "Dark"
    })
  })
});

export function buildMapThemeConfig() {
  return {
    providers: Object.values(MAP_THEME_PROVIDERS).map((provider) => ({
      id: provider.id,
      label: provider.label,
      themes: provider.themes.map((theme) => ({ ...theme }))
    })),
    rules: {
      ...MAP_THEME_RULES,
      defaultThemeByProvider: { ...MAP_THEME_RULES.defaultThemeByProvider },
      spriteByTheme: { ...MAP_THEME_RULES.spriteByTheme },
      fallback: {
        ...MAP_THEME_RULES.fallback,
        themeMap: { ...MAP_THEME_RULES.fallback.themeMap }
      }
    }
  };
}
