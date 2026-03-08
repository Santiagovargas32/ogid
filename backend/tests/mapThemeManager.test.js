import test from "node:test";
import assert from "node:assert/strict";

function installWindowMock() {
  const storage = new Map();
  global.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      }
    }
  };
}

test("map theme manager resolves PMTiles fallback to OpenFreeMap theme pairs", async () => {
  installWindowMock();
  const { MapThemeManager } = await import("../../frontend/js/mapTheme/mapThemeManager.js");

  const manager = new MapThemeManager({
    providers: [
      { id: "PMTiles", themes: [{ id: "Dark" }, { id: "Light" }] },
      { id: "OpenFreeMap", themes: [{ id: "Dark" }, { id: "Positron" }] }
    ],
    rules: {
      defaultProvider: "PMTiles",
      defaultThemeByProvider: {
        PMTiles: "Dark",
        OpenFreeMap: "Dark"
      },
      spriteByTheme: {
        "PMTiles:Dark": "dark",
        "PMTiles:Light": "light",
        "OpenFreeMap:Dark": "dark",
        "OpenFreeMap:Positron": "light"
      },
      fallback: {
        fromProvider: "PMTiles",
        toProvider: "OpenFreeMap",
        themeMap: {
          Dark: "Dark",
          Light: "Positron"
        }
      }
    }
  });

  manager.setProvider("PMTiles");
  manager.setTheme("Light");

  assert.deepEqual(manager.resolveFallback(), {
    provider: "OpenFreeMap",
    theme: "Positron"
  });
});
