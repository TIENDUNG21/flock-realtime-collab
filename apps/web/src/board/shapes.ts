import type { Json } from '@flock/crdt';

/** The board uses a fixed logical coordinate space, scaled to the canvas on screen. */
export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 1000;
export const MAX_STROKE_POINTS = 2000;

export interface Stroke {
  readonly kind: 'stroke';
  readonly color: string;
  readonly width: number;
  /** Flat list x0, y0, x1, y1, ... in board units (integers). */
  readonly points: readonly number[];
  readonly z: number;
}

export interface Box {
  readonly kind: 'rect' | 'ellipse';
  readonly color: string;
  readonly width: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
}

export type Shape = Stroke | Box;

const COLOR = /^#[0-9a-f]{6}$/i;

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;

/**
 * Validates a shape that came from the shared map. Other peers are not trusted: anything
 * malformed (wrong kind, non-finite or out-of-range numbers, oversized strokes, non-hex colors)
 * yields null and is simply not drawn.
 */
export function parseShape(value: Json | undefined): Shape | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Readonly<Record<string, Json>>;
  const color = typeof v['color'] === 'string' && COLOR.test(v['color']) ? v['color'] : null;
  const width = num(v['width'], 1, 40);
  const z = num(v['z'], 0, Number.MAX_SAFE_INTEGER);
  if (color === null || width === null || z === null) return null;
  if (v['kind'] === 'stroke') {
    const raw = v['points'];
    if (!Array.isArray(raw) || raw.length < 2 || raw.length % 2 !== 0) return null;
    if (raw.length > MAX_STROKE_POINTS * 2) return null;
    const points: number[] = [];
    for (const p of raw as readonly Json[]) {
      const n = num(p, -BOARD_WIDTH, BOARD_WIDTH * 2);
      if (n === null) return null;
      points.push(n);
    }
    return { kind: 'stroke', color, width, points, z };
  }
  if (v['kind'] === 'rect' || v['kind'] === 'ellipse') {
    const x = num(v['x'], -BOARD_WIDTH, BOARD_WIDTH * 2);
    const y = num(v['y'], -BOARD_HEIGHT, BOARD_HEIGHT * 2);
    const w = num(v['w'], 0, BOARD_WIDTH * 2);
    const h = num(v['h'], 0, BOARD_HEIGHT * 2);
    if (x === null || y === null || w === null || h === null) return null;
    return { kind: v['kind'], color, width, x, y, w, h, z };
  }
  return null;
}

/** A rectangle from two corner points, normalised to positive width and height. */
export function boxFrom(
  kind: 'rect' | 'ellipse',
  a: { x: number; y: number },
  b: { x: number; y: number },
  style: { color: string; width: number; z: number },
): Box {
  return {
    kind,
    ...style,
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.round(Math.abs(a.x - b.x)),
    h: Math.round(Math.abs(a.y - b.y)),
  };
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ramer–Douglas–Peucker simplification of a flat point list: drops points closer than
 * `tolerance` to the line through their neighbours, then rounds to integers. Keeps strokes
 * small on the wire without visible change.
 */
export function simplifyStroke(points: readonly number[], tolerance = 1.5): number[] {
  const n = points.length / 2;
  if (n <= 2) return points.map(Math.round);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  const x = (i: number): number => points[2 * i] ?? 0;
  const y = (i: number): number => points[2 * i + 1] ?? 0;
  while (stack.length > 0) {
    const [first, last] = stack.pop() ?? [0, 0];
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(x(i), y(i), x(first), y(first), x(last), y(last));
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index >= 0 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(Math.round(x(i)), Math.round(y(i)));
  return out;
}

/** True when (px, py) is within `radius` of the shape's outline (used by the eraser). */
export function hitTest(shape: Shape, px: number, py: number, radius: number): boolean {
  const r = radius + shape.width / 2;
  if (shape.kind === 'stroke') {
    const p = shape.points;
    if (p.length === 2) return Math.hypot(px - (p[0] ?? 0), py - (p[1] ?? 0)) <= r;
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (distanceToSegment(px, py, p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0, p[i + 3] ?? 0) <= r) {
        return true;
      }
    }
    return false;
  }
  if (shape.kind === 'rect') {
    const { x, y, w, h } = shape;
    const inside = px >= x - r && px <= x + w + r && py >= y - r && py <= y + h + r;
    const deep = px > x + r && px < x + w - r && py > y + r && py < y + h - r;
    return inside && !deep;
  }
  const rx = shape.w / 2;
  const ry = shape.h / 2;
  if (rx === 0 || ry === 0) return false;
  const cx = shape.x + rx;
  const cy = shape.y + ry;
  // Distance from the ellipse outline, approximated in normalised space.
  const d = Math.hypot((px - cx) / rx, (py - cy) / ry);
  return Math.abs(d - 1) * Math.min(rx, ry) <= r;
}

/** Shapes in paint order: lower z first, ties broken by key so every peer paints the same. */
export function paintOrder(entries: Iterable<[string, Shape]>): Array<[string, Shape]> {
  return [...entries].sort(([ka, a], [kb, b]) => a.z - b.z || (ka < kb ? -1 : ka > kb ? 1 : 0));
}
