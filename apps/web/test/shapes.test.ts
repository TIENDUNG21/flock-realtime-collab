import { describe, expect, it } from 'vitest';
import type { Json } from '@flock/crdt';
import {
  boxFrom,
  hitTest,
  paintOrder,
  parseShape,
  simplifyStroke,
  type Shape,
} from '../src/board/shapes.js';

const stroke = { kind: 'stroke', color: '#2dd4bf', width: 4, points: [0, 0, 100, 0], z: 1 };

describe('parseShape', () => {
  it('accepts valid strokes, rectangles and ellipses', () => {
    expect(parseShape(stroke)).toEqual(stroke);
    const rect = { kind: 'rect', color: '#f5b942', width: 3, x: 10, y: 20, w: 30, h: 40, z: 2 };
    expect(parseShape(rect)).toEqual(rect);
    expect(parseShape({ ...rect, kind: 'ellipse' })?.kind).toBe('ellipse');
  });

  it.each<[string, Json]>([
    ['null', null],
    ['array', [1, 2]],
    ['unknown kind', { ...stroke, kind: 'triangle' }],
    ['css injection color', { ...stroke, color: 'red;background:url(x)' }],
    ['odd point count', { ...stroke, points: [1, 2, 3] }],
    ['string point', { ...stroke, points: [1, '2'] }],
    ['far away point', { ...stroke, points: [1, 1e9] }],
    ['zero width', { ...stroke, width: 0 }],
    [
      'negative box size',
      { kind: 'rect', color: '#ffffff', width: 2, x: 0, y: 0, w: -5, h: 5, z: 1 },
    ],
    ['missing z', { kind: 'rect', color: '#ffffff', width: 2, x: 0, y: 0, w: 5, h: 5 }],
  ])('rejects %s', (_name, value) => {
    expect(parseShape(value)).toBeNull();
  });

  it('rejects oversized strokes', () => {
    expect(parseShape({ ...stroke, points: new Array<number>(4002).fill(1) })).toBeNull();
  });
});

describe('simplifyStroke', () => {
  it('drops points on a straight line and keeps corners', () => {
    const line = [0, 0, 10, 0.2, 20, -0.1, 30, 0, 30, 10, 30, 20];
    expect(simplifyStroke(line)).toEqual([0, 0, 30, 0, 30, 20]);
  });

  it('keeps tiny strokes and rounds coordinates', () => {
    expect(simplifyStroke([1.4, 2.6])).toEqual([1, 3]);
  });
});

describe('boxFrom', () => {
  it('normalises corners dragged in any direction', () => {
    const style = { color: '#ffffff', width: 2, z: 3 };
    expect(boxFrom('rect', { x: 50, y: 60 }, { x: 10, y: 20 }, style)).toMatchObject({
      x: 10,
      y: 20,
      w: 40,
      h: 40,
    });
  });
});

describe('hitTest', () => {
  const rect: Shape = {
    kind: 'rect',
    color: '#ffffff',
    width: 2,
    x: 100,
    y: 100,
    w: 100,
    h: 50,
    z: 1,
  };
  const ellipse: Shape = { ...rect, kind: 'ellipse' };

  it('hits a stroke near its segments only', () => {
    const s = parseShape(stroke);
    expect(s && hitTest(s, 50, 3, 2)).toBe(true);
    expect(s && hitTest(s, 50, 30, 2)).toBe(false);
  });

  it('hits rectangle and ellipse outlines but not their empty middle', () => {
    expect(hitTest(rect, 100, 125, 3)).toBe(true);
    expect(hitTest(rect, 150, 125, 3)).toBe(false);
    expect(hitTest(ellipse, 150, 100, 3)).toBe(true);
    expect(hitTest(ellipse, 150, 125, 3)).toBe(false);
  });
});

describe('paintOrder', () => {
  it('sorts by z, then by key, identically on every peer', () => {
    const a: Shape = { ...stroke, kind: 'stroke', z: 2 };
    const b: Shape = { ...stroke, kind: 'stroke', z: 1 };
    const c: Shape = { ...stroke, kind: 'stroke', z: 2 };
    expect(
      paintOrder([
        ['k3', a],
        ['k1', b],
        ['k2', c],
      ]).map(([k]) => k),
    ).toEqual(['k1', 'k2', 'k3']);
  });
});
