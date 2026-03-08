import { BaseMapEngine } from "./mapEngine.js";

export class WebGLEngine extends BaseMapEngine {
  init() {
    const container = document.getElementById(this.elementId);
    if (!container) {
      return;
    }

    container.innerHTML = `
      <div class="webgl-engine-placeholder">
        <h3>WebGL Engine Ready</h3>
        <p>Compatibility scaffold enabled for <code>deck.gl</code>, <code>globe.gl</code>, and <code>Three.js</code>.</p>
        <p>Leaflet remains the active production renderer for live intelligence layers.</p>
      </div>
    `;
  }

  destroy() {
    const container = document.getElementById(this.elementId);
    if (container) {
      container.innerHTML = "";
    }
  }
}
