import type { Doc, Json, MapType } from '@flock/crdt';
import type { Awareness } from '@flock/sync';
import { parsePresence } from '../editor/presence.js';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_STROKE_POINTS,
  boxFrom,
  hitTest,
  paintOrder,
  parseShape,
  simplifyStroke,
  type Shape,
} from './shapes.js';

export type Tool = 'pen' | 'rect' | 'ellipse' | 'eraser';

interface Point {
  readonly x: number;
  readonly y: number;
}

const POINTER_INTERVAL_MS = 50;

function shapeToJson(shape: Shape): Json {
  return shape.kind === 'stroke'
    ? {
        kind: 'stroke',
        color: shape.color,
        width: shape.width,
        points: [...shape.points],
        z: shape.z,
      }
    : {
        kind: shape.kind,
        color: shape.color,
        width: shape.width,
        x: shape.x,
        y: shape.y,
        w: shape.w,
        h: shape.h,
        z: shape.z,
      };
}

/**
 * Shared whiteboard on a <canvas>. Every finished shape is one entry of a shared LWW map
 * (`<replica>-<n>` -> shape JSON), so concurrent drawing never conflicts and erasing is a
 * key deletion. Live pointers travel through awareness, not through the document.
 */
export class Whiteboard {
  tool: Tool = 'pen';
  color = '#2dd4bf';
  width = 4;
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #map: MapType;
  readonly #doc: Doc;
  readonly #awareness: Awareness;
  readonly #shapes = new Map<string, Shape>();
  readonly #off: Array<() => void> = [];
  #counter = 0;
  #start: Point | null = null;
  #points: number[] = [];
  #draft: Shape | null = null;
  #lastPointerSent = 0;
  #frame = 0;

  constructor(canvas: HTMLCanvasElement, map: MapType, doc: Doc, awareness: Awareness) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#map = map;
    this.#doc = doc;
    this.#awareness = awareness;
    this.#rebuild();
    this.#off.push(
      doc.on('change', (e) => {
        if (e.targets.has(map.name)) {
          this.#rebuild();
          this.schedule();
        }
      }),
      awareness.on('change', () => {
        this.schedule();
      }),
    );
    const resize = new ResizeObserver(() => {
      this.#resize();
    });
    resize.observe(canvas);
    this.#off.push(() => {
      resize.disconnect();
    });
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => {
      canvas.addEventListener(type, fn);
      this.#off.push(() => {
        canvas.removeEventListener(type, fn);
      });
    };
    on('pointerdown', (e) => {
      this.#down(e);
    });
    on('pointermove', (e) => {
      this.#move(e);
    });
    on('pointerup', () => {
      this.#up();
    });
    on('pointercancel', () => {
      this.#cancel();
    });
    on('pointerleave', () => {
      this.#awareness.setLocalField('pointer', null);
    });
    this.#resize();
  }

  /** Number of shapes currently on the board. */
  get shapeCount(): number {
    return this.#shapes.size;
  }

  clear(): void {
    this.#doc.transact(() => {
      for (const key of this.#map.keys()) this.#map.delete(key);
    });
  }

  schedule(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#render();
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.#frame);
    for (const off of this.#off.splice(0)) off();
  }

  #rebuild(): void {
    this.#shapes.clear();
    for (const [key, value] of this.#map.entries()) {
      const shape = parseShape(value);
      if (shape) this.#shapes.set(key, shape);
    }
  }

  #resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.#canvas.getBoundingClientRect();
    this.#canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.#canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.schedule();
  }

  #toBoard(e: PointerEvent): Point {
    const rect = this.#canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * BOARD_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * BOARD_HEIGHT,
    };
  }

  #nextZ(): number {
    let max = 0;
    for (const shape of this.#shapes.values()) max = Math.max(max, shape.z);
    return max + 1;
  }

  #down(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.#canvas.setPointerCapture(e.pointerId);
    const p = this.#toBoard(e);
    this.#start = p;
    this.#points = [p.x, p.y];
    if (this.tool === 'eraser') this.#erase(p);
    this.#updateDraft(p);
  }

  #move(e: PointerEvent): void {
    const p = this.#toBoard(e);
    const now = performance.now();
    if (now - this.#lastPointerSent > POINTER_INTERVAL_MS) {
      this.#lastPointerSent = now;
      this.#awareness.setLocalField('pointer', { x: Math.round(p.x), y: Math.round(p.y) });
    }
    if (!this.#start) return;
    if (this.tool === 'eraser') {
      this.#erase(p);
      return;
    }
    if (this.tool === 'pen' && this.#points.length < MAX_STROKE_POINTS * 2)
      this.#points.push(p.x, p.y);
    this.#updateDraft(p);
  }

  #up(): void {
    const draft = this.#draft;
    this.#cancel();
    if (!draft) return;
    const shape: Shape =
      draft.kind === 'stroke' ? { ...draft, points: simplifyStroke(draft.points) } : draft;
    if (shape.kind !== 'stroke' && shape.w < 3 && shape.h < 3) return;
    this.#map.set(`${this.#doc.replicaId}-${++this.#counter}`, shapeToJson(shape));
  }

  #cancel(): void {
    this.#start = null;
    this.#points = [];
    this.#draft = null;
    this.schedule();
  }

  #updateDraft(p: Point): void {
    const style = { color: this.color, width: this.width, z: this.#nextZ() };
    if (this.tool === 'pen') {
      this.#draft = { kind: 'stroke', ...style, points: [...this.#points] };
    } else if ((this.tool === 'rect' || this.tool === 'ellipse') && this.#start) {
      this.#draft = boxFrom(this.tool, this.#start, p, style);
    }
    this.schedule();
  }

  #erase(p: Point): void {
    const hits = [...this.#shapes].filter(([, shape]) => hitTest(shape, p.x, p.y, 8));
    if (hits.length === 0) return;
    this.#doc.transact(() => {
      for (const [key] of hits) this.#map.delete(key);
    });
  }

  #render(): void {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const scale = width / BOARD_WIDTH;
    ctx.setTransform(scale, 0, 0, height / BOARD_HEIGHT, 0, 0);

    ctx.fillStyle = 'rgba(237, 237, 237, 0.07)';
    for (let x = 40; x < BOARD_WIDTH; x += 40) {
      for (let y = 40; y < BOARD_HEIGHT; y += 40) ctx.fillRect(x - 1, y - 1, 2, 2);
    }

    const shapes = paintOrder(this.#shapes);
    if (this.#draft) shapes.push(['draft', this.#draft]);
    for (const [, shape] of shapes) this.#draw(shape);

    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    for (const [replica, state] of this.#awareness.getStates()) {
      if (replica === this.#awareness.replicaId) continue;
      const presence = parsePresence(state);
      if (!presence?.pointer) continue;
      const { x, y } = presence.pointer;
      ctx.fillStyle = presence.color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6, y + 26);
      ctx.lineTo(x + 12, y + 16);
      ctx.lineTo(x + 24, y + 14);
      ctx.closePath();
      ctx.fill();
      const label = presence.name;
      const w = ctx.measureText(label).width + 16;
      ctx.fillRect(x + 16, y + 22, w, 30);
      ctx.fillStyle = '#0a0a0a';
      ctx.fillText(label, x + 24, y + 44);
    }
  }

  #draw(shape: Shape): void {
    const ctx = this.#ctx;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (shape.kind === 'stroke') {
      const p = shape.points;
      ctx.moveTo(p[0] ?? 0, p[1] ?? 0);
      if (p.length === 2) ctx.lineTo((p[0] ?? 0) + 0.1, p[1] ?? 0);
      for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i] ?? 0, p[i + 1] ?? 0);
    } else if (shape.kind === 'rect') {
      ctx.rect(shape.x, shape.y, shape.w, shape.h);
    } else {
      ctx.ellipse(
        shape.x + shape.w / 2,
        shape.y + shape.h / 2,
        shape.w / 2,
        shape.h / 2,
        0,
        0,
        Math.PI * 2,
      );
    }
    ctx.stroke();
  }
}
