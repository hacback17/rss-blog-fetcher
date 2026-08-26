// A small, dependency-free force-directed graph renderer (canvas-based).
// Not a general-purpose library — just enough physics (repulsion + spring
// edges + centering + damping) to lay out a few hundred nodes interactively,
// with drag/pan/zoom and click detection. Colors are read from the page's
// CSS custom properties at render time, so it follows the light/dark theme
// automatically.

const REPULSION = 3200;
const SPRING_LENGTH = 100;
const SPRING_STRENGTH = 0.02;
const CENTER_STRENGTH = 0.015;
const DAMPING = 0.72;
// d3-force-style cooling schedule: every tick's forces are scaled by
// `alpha`, which decays geometrically toward 0. This is what actually
// *guarantees* the simulation settles within a bounded number of ticks,
// regardless of how dense the graph is — relying on velocity damping alone
// (the previous approach) let a sufficiently dense/oscillatory graph (e.g.
// a common tag with 150+ heavily-cross-tagged articles) jitter forever
// instead of converging, which read as the layout "flickering".
const ALPHA_DECAY = 0.02;
const ALPHA_MIN = 0.002;
// Hard ceiling on per-tick force/velocity, as a second line of defense: a
// very dense graph can still build up a large force on a single tick before
// alpha has decayed much, and a single unbounded tick is enough to overflow
// a position to Infinity/NaN (which then renders nothing, permanently).
const MAX_FORCE = 60;
const MAX_VELOCITY = 30;
// Below this on-screen radius (in CSS px, i.e. already ×zoom), a label is
// skipped — with 100+ nodes on screen at once, drawing every label produces
// unreadable overlapping text. Zooming in or hovering still reveals it.
const MIN_LABEL_PX = 13;

export class ForceGraph {
  constructor(canvas, { onNodeClick, onHoverChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onNodeClick = onNodeClick;
    this.onHoverChange = onHoverChange;
    this.nodes = [];
    this.edges = [];
    this.alpha = 0;
    this.transform = { x: 0, y: 0, scale: 1 };
    this.dragNode = null;
    this.dragMoved = false;
    this.panning = false;
    this.hoverNode = null;
    this.lastPointer = { x: 0, y: 0 };
    this._raf = null;
    this._destroyed = false;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    canvas.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    canvas.addEventListener("wheel", this._onWheel, { passive: false });

    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas.parentElement);
    this._resize();
  }

  // nodes: [{id, label, count}], edges: [{source, target, weight}]
  setData(nodes, edges) {
    const existing = new Map(this.nodes.map((n) => [n.id, n]));
    const maxCount = Math.max(1, ...nodes.map((n) => n.count || 1));
    this.nodes = nodes.map((n) => {
      const prev = existing.get(n.id);
      const radius = 6 + 16 * Math.sqrt((n.count || 1) / maxCount);
      if (prev) return { ...prev, ...n, radius };
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 120;
      return { ...n, radius, x: Math.cos(angle) * dist, y: Math.sin(angle) * dist, vx: 0, vy: 0 };
    });
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = edges.filter((e) => byId.has(e.source) && byId.has(e.target));
    this.transform = { x: 0, y: 0, scale: 1 };
    this.alpha = 1;
    this._wake();
  }

  destroy() {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.removeEventListener("wheel", this._onWheel);
    this._resizeObserver.disconnect();
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, rect.width * dpr);
    this.canvas.height = Math.max(1, rect.height * dpr);
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this._wake();
  }

  _wake() {
    if (this._raf || this._destroyed) return;
    this._raf = requestAnimationFrame(() => this._tick());
  }

  _tick() {
    if (this._destroyed) return;
    this._step();
    this._draw();
    const settled = this.alpha < ALPHA_MIN;
    if (!settled || this.dragNode || this.panning) {
      this._raf = requestAnimationFrame(() => this._tick());
    } else {
      this._raf = null;
    }
  }

  // Reheats the simulation so it settles again (e.g. after a drag, or new
  // data) instead of staying frozen at whatever alpha it last cooled to.
  _reheat(alpha = 1) {
    this.alpha = Math.max(this.alpha, alpha);
    this._wake();
  }

  _step() {
    if (this.alpha < ALPHA_MIN) return;
    const nodes = this.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const alpha = this.alpha;

    for (const n of nodes) {
      if (n === this.dragNode) continue;
      let fx = -n.x * CENTER_STRENGTH;
      let fy = -n.y * CENTER_STRENGTH;
      for (const other of nodes) {
        if (other === n) continue;
        let dx = n.x - other.x;
        let dy = n.y - other.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
      n._fx = fx;
      n._fy = fy;
    }
    for (const e of this.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const strength = SPRING_STRENGTH * Math.min(3, 1 + Math.log(1 + e.weight));
      const force = (dist - SPRING_LENGTH) * strength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (a !== this.dragNode) { a._fx += fx; a._fy += fy; }
      if (b !== this.dragNode) { b._fx -= fx; b._fy -= fy; }
    }

    for (const n of nodes) {
      if (n === this.dragNode) continue;
      const fx = clamp(n._fx * alpha, MAX_FORCE);
      const fy = clamp(n._fy * alpha, MAX_FORCE);
      n.vx = clamp((n.vx + fx) * DAMPING, MAX_VELOCITY);
      n.vy = clamp((n.vy + fy) * DAMPING, MAX_VELOCITY);
      n.x += n.vx;
      n.y += n.vy;
    }

    this.alpha *= 1 - ALPHA_DECAY;
  }

  _colors() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--text").trim() || "#333",
      textMuted: style.getPropertyValue("--text-muted").trim() || "#888",
      accent: style.getPropertyValue("--accent").trim() || "#1c6e4a",
      accentBg: style.getPropertyValue("--accent-bg").trim() || "#e8f4ee",
      border: style.getPropertyValue("--border").trim() || "#ddd",
    };
  }

  _draw() {
    const ctx = this.ctx;
    const c = this._colors();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.translate(this.width / 2 + this.transform.x, this.height / 2 + this.transform.y);
    ctx.scale(this.transform.scale, this.transform.scale);

    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    ctx.lineWidth = 1 / this.transform.scale;
    for (const e of this.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const highlighted = this.hoverNode && (this.hoverNode === a || this.hoverNode === b);
      ctx.strokeStyle = highlighted ? c.accent : c.border;
      ctx.globalAlpha = highlighted ? 0.9 : Math.min(0.55, 0.15 + e.weight * 0.05);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Labels below MIN_LABEL_PX on-screen are skipped (zoom in or hover to
    // reveal them) — with 100+ nodes visible at once, drawing every label
    // produces unreadable overlapping text rather than a legible graph.
    for (const n of this.nodes) {
      const isHover = n === this.hoverNode;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = isHover ? c.accent : c.accentBg;
      ctx.fill();
      ctx.lineWidth = (isHover ? 2 : 1) / this.transform.scale;
      ctx.strokeStyle = c.accent;
      ctx.stroke();

      const fontSize = Math.max(9, Math.min(13, n.radius * 0.7));
      if (isHover || fontSize * this.transform.scale > MIN_LABEL_PX) {
        ctx.font = `${isHover ? "600" : "500"} ${fontSize}px -apple-system, sans-serif`;
        ctx.fillStyle = isHover ? c.accent : c.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(truncateLabel(n.label, 22), n.x, n.y + n.radius + 3);
      }
    }
    ctx.restore();
  }

  _toGraphCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left - this.width / 2 - this.transform.x;
    const y = clientY - rect.top - this.height / 2 - this.transform.y;
    return { x: x / this.transform.scale, y: y / this.transform.scale };
  }

  _nodeAt(clientX, clientY) {
    const { x, y } = this._toGraphCoords(clientX, clientY);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy <= n.radius * n.radius) return n;
    }
    return null;
  }

  _onPointerDown(e) {
    const node = this._nodeAt(e.clientX, e.clientY);
    this.dragMoved = false;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (node) {
      this.dragNode = node;
      this.canvas.setPointerCapture(e.pointerId);
      this._reheat(0.4); // let the rest of the graph react to the node being moved
    } else {
      this.panning = true;
      this.canvas.classList.add("dragging");
      this._wake();
    }
  }

  _onPointerMove(e) {
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.dragMoved = true;

    if (this.dragNode) {
      const { x, y } = this._toGraphCoords(e.clientX, e.clientY);
      this.dragNode.x = x;
      this.dragNode.y = y;
      this.dragNode.vx = 0;
      this.dragNode.vy = 0;
      this._wake();
    } else if (this.panning) {
      this.transform.x += dx;
      this.transform.y += dy;
      this._wake();
    } else {
      const node = this._nodeAt(e.clientX, e.clientY);
      if (node !== this.hoverNode) {
        this.hoverNode = node;
        this.onHoverChange?.(node, e.clientX, e.clientY);
        this._wake();
      } else if (node) {
        this.onHoverChange?.(node, e.clientX, e.clientY);
      }
    }
    this.lastPointer = { x: e.clientX, y: e.clientY };
  }

  _onPointerUp(e) {
    if (this.dragNode && !this.dragMoved) {
      this.onNodeClick?.(this.dragNode);
    }
    this.dragNode = null;
    this.panning = false;
    this.canvas.classList.remove("dragging");
  }

  _onWheel(e) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    this.transform.scale = Math.min(4, Math.max(0.2, this.transform.scale * factor));
    this._wake();
  }
}

function truncateLabel(label, max) {
  if (!label) return "";
  return label.length > max ? label.slice(0, max - 1) + "…" : label;
}

function clamp(value, max) {
  if (value > max) return max;
  if (value < -max) return -max;
  return value;
}
