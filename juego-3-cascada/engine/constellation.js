/**
 * Renderizador de la constelación del Juego 3 — Cascada.
 *
 * Dibuja el grafo que produce el motor (cascade-sim.js) como una constelación
 * de estrellas: el evento a la izquierda, el fan-out en el centro, los canales
 * a la derecha y el destino (fila en notifications o correo enviado) al fondo.
 *
 * Es un lector pasivo del grafo: no decide nada, no muta el motor y no usa
 * Math.random. Recibe `sync(graph)` y dibuja el estado actual.
 *
 * Uso en navegador:  const view = new CascadeView.View({ container, THREE });
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CascadeView = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var COLORS = {
    ok: 0x5eead4,
    warn: 0xfbbf24,
    danger: 0xfb7185,
    pending: 0x64748b,
    event: 0xa78bfa,
    fanout: 0x22d3ee
  };

  var LAYER_Z = { event: 2.5, fanout: 1, channel: -1, sink: -2.5 };

  function View(options) {
    options = options || {};
    this.THREE = options.THREE;
    this.container = options.container;
    this.nodes = {};
    this.links = {};
    this.textures = {};
    this.clock = new this.THREE.Clock();
    this.pointer = { x: 0, y: 0 };
    this.rotation = 0;

    var THREE = this.THREE;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x080d18, 0.018);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
    this.camera.position.set(0, 1.5, 32);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x080d18, 1);
    this.container.appendChild(this.renderer.domElement);

    this._buildStarfield();
    this._bindEvents();
    this.resize();
  }

  /* ------------------------------------------------------------------ */
  /* Escena                                                             */
  /* ------------------------------------------------------------------ */

  View.prototype._buildStarfield = function () {
    var THREE = this.THREE;
    var count = 520;
    var positions = new Float32Array(count * 3);
    var seed = 20261102;
    for (var i = 0; i < count; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var rx = (seed / 4294967296) * 2 - 1;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var ry = (seed / 4294967296) * 2 - 1;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var rz = (seed / 4294967296) * 2 - 1;
      var radius = 55 + ((seed % 40) / 40) * 40;
      positions[i * 3] = rx * radius;
      positions[i * 3 + 1] = ry * radius;
      positions[i * 3 + 2] = -20 - Math.abs(rz) * radius;
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    var material = new THREE.PointsMaterial({
      color: 0x334a6b,
      size: 0.45,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7
    });
    this.starfield = new THREE.Points(geometry, material);
    this.scene.add(this.starfield);
  };

  View.prototype._bindEvents = function () {
    var self = this;

    this._onResize = function () {
      self.resize();
    };
    window.addEventListener("resize", this._onResize);

    this._onPointer = function (event) {
      var rect = self.container.getBoundingClientRect();
      self.pointer.x = (event.clientX - rect.left) / rect.width - 0.5;
      self.pointer.y = (event.clientY - rect.top) / rect.height - 0.5;
    };
    this.container.addEventListener("pointermove", this._onPointer);
  };

  View.prototype.resize = function () {
    var width = this.container.clientWidth || 800;
    var height = this.container.clientHeight || 460;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  /* ------------------------------------------------------------------ */
  /* Texturas                                                           */
  /* ------------------------------------------------------------------ */

  View.prototype._glowTexture = function (color) {
    var THREE = this.THREE;
    var key = "glow:" + color;
    if (this.textures[key]) return this.textures[key];

    var size = 128;
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext("2d");
    var hex = "#" + color.toString(16).padStart(6, "0");
    var gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, hex);
    gradient.addColorStop(0.25, hex + "cc");
    gradient.addColorStop(0.55, hex + "33");
    gradient.addColorStop(1, hex + "00");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    var texture = new THREE.CanvasTexture(canvas);
    // r149 usa `encoding`; r152+ usa `colorSpace`.
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    else texture.encoding = THREE.sRGBEncoding;
    this.textures[key] = texture;
    return texture;
  };

  View.prototype._labelTexture = function (text, sub) {
    var THREE = this.THREE;
    var key = "label:" + text + "|" + sub;
    if (this.textures[key]) return this.textures[key];

    var width = 512;
    var height = 128;
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e9eefc";
    ctx.font = "600 34px Outfit, system-ui, sans-serif";
    ctx.fillText(text, width / 2, 48);
    if (sub) {
      ctx.fillStyle = "#8ea2c6";
      ctx.font = "400 26px 'JetBrains Mono', ui-monospace, monospace";
      ctx.fillText(sub, width / 2, 88);
    }

    var texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    else texture.encoding = THREE.sRGBEncoding;
    this.textures[key] = texture;
    return texture;
  };

  /* ------------------------------------------------------------------ */
  /* Nodos y enlaces                                                    */
  /* ------------------------------------------------------------------ */

  View.prototype._colorFor = function (node) {
    if (node.state === "ok") return COLORS.ok;
    if (node.state === "warn") return COLORS.warn;
    if (node.state === "danger") return COLORS.danger;
    if (node.kind === "event") return COLORS.event;
    if (node.kind === "fanout") return COLORS.fanout;
    return COLORS.pending;
  };

  View.prototype._position = function (node) {
    var THREE = this.THREE;
    return new THREE.Vector3(
      node.x,
      node.y * 0.85,
      LAYER_Z[node.layer] != null ? LAYER_Z[node.layer] : 0
    );
  };

  View.prototype.sync = function (graph) {
    var self = this;
    var THREE = this.THREE;

    (graph.nodes || []).forEach(function (node) {
      var entry = self.nodes[node.id];
      var color = self._colorFor(node);

      if (!entry) {
        var material = new THREE.SpriteMaterial({
          map: self._glowTexture(color),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        });
        var sprite = new THREE.Sprite(material);
        sprite.scale.setScalar(node.kind === "event" ? 3.4 : 2.4);

        var labelMaterial = new THREE.SpriteMaterial({
          map: self._labelTexture(node.label, node.sub),
          transparent: true,
          depthWrite: false
        });
        var label = new THREE.Sprite(labelMaterial);
        label.scale.set(6.4, 1.6, 1);
        label.position.y = -1.5;

        var group = new THREE.Group();
        group.add(sprite);
        group.add(label);
        group.position.copy(self._position(node));
        self.scene.add(group);

        entry = { group: group, sprite: sprite, label: label, node: node, phase: 0 };
        self.nodes[node.id] = entry;
      } else {
        entry.node = node;
        entry.sprite.material.map = self._glowTexture(color);
        entry.sprite.material.needsUpdate = true;
        entry.label.material.map = self._labelTexture(node.label, node.sub);
        entry.label.material.needsUpdate = true;
      }
    });

    (graph.links || []).forEach(function (link) {
      if (self.links[link.id]) {
        self.links[link.id].link = link;
        return;
      }
      var from = self.nodes[link.from];
      var to = self.nodes[link.to];
      if (!from || !to) return;

      var start = from.group.position.clone();
      var end = to.group.position.clone();
      var mid = start.clone().add(end).multiplyScalar(0.5);
      mid.y += 1.4;
      var curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      var geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48));

      var color =
        link.state === "danger" ? COLORS.danger :
        link.state === "warn" ? COLORS.warn :
        link.state === "ok" ? COLORS.ok : COLORS.pending;

      var material = new THREE.LineBasicMaterial({
        color: color,
        transparent: true,
        opacity: link.state === "pending" ? 0.35 : 0.85
      });
      var line = new THREE.Line(geometry, material);
      self.scene.add(line);
      self.links[link.id] = { line: line, link: link };
    });
  };

  /* ------------------------------------------------------------------ */
  /* Bucle de dibujo                                                    */
  /* ------------------------------------------------------------------ */

  View.prototype.render = function () {
    var self = this;
    var THREE = this.THREE;
    var elapsed = this.clock.getElapsedTime();

    this.rotation += 0.0012;
    this.starfield.rotation.y = this.rotation;

    Object.keys(this.nodes).forEach(function (id) {
      var entry = self.nodes[id];
      var pulse = 1 + Math.sin(elapsed * 2.2 + entry.group.position.x) * 0.08;
      var base = entry.node.kind === "event" ? 3.4 : 2.4;
      entry.sprite.scale.setScalar(base * pulse);
    });

    Object.keys(this.links).forEach(function (id) {
      var entry = self.links[id];
      var flow = 0.55 + 0.35 * Math.sin(elapsed * 2.6 + entry.line.geometry.attributes.position.count);
      entry.line.material.opacity = Math.max(0.2, Math.min(1, flow));
    });

    this.camera.position.x += (this.pointer.x * 4 - this.camera.position.x) * 0.05;
    this.camera.position.y += (1.5 - this.pointer.y * 3 - this.camera.position.y) * 0.05;
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
  };

  /** Limpia la constelación (reinicio de nivel). Las texturas se cachean y se conservan. */
  View.prototype.clear = function () {
    var self = this;
    Object.keys(this.nodes).forEach(function (id) {
      var entry = self.nodes[id];
      self.scene.remove(entry.group);
      entry.sprite.material.dispose();
      entry.label.material.dispose();
    });
    Object.keys(this.links).forEach(function (id) {
      var entry = self.links[id];
      self.scene.remove(entry.line);
      entry.line.geometry.dispose();
      entry.line.material.dispose();
    });
    this.nodes = {};
    this.links = {};
    return this;
  };

  View.prototype.dispose = function () {
    window.removeEventListener("resize", this._onResize);
    this.container.removeEventListener("pointermove", this._onPointer);
    if (this.renderer && this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  };

  return { View: View, COLORS: COLORS };
});
