import type { Id, Json, RelativePosition } from '@flock/crdt';

/** What each participant publishes through awareness. */
export interface Presence {
  readonly name: string;
  readonly color: string;
  /** Text selection as relative positions (survive concurrent edits). */
  readonly selection: { readonly anchor: RelativePosition; readonly head: RelativePosition } | null;
  /** Pointer position on the board, in board units. */
  readonly pointer: { readonly x: number; readonly y: number } | null;
}

export const MAX_NAME_LENGTH = 32;
const COLOR = /^#[0-9a-f]{6}$/i;

type Obj = Readonly<Record<string, Json>>;
const isObj = (v: Json | undefined): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function parseId(v: Json | undefined): Id | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const { replica, seq } = v;
  if (typeof replica !== 'string' || replica.length === 0 || replica.length > 64) return undefined;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return undefined;
  return { replica, seq };
}

function parsePosition(v: Json | undefined): RelativePosition | null {
  if (!isObj(v)) return null;
  const anchor = parseId(v['anchor']);
  const side = v['side'];
  if (anchor === undefined || (side !== 'left' && side !== 'right')) return null;
  return { anchor, side };
}

/** Validates a presence state from another peer; returns null if it is unusable. */
export function parsePresence(value: Json | undefined): Presence | null {
  if (!isObj(value)) return null;
  const name = value['name'];
  const color = value['color'];
  if (typeof name !== 'string' || typeof color !== 'string' || !COLOR.test(color)) return null;
  let selection: Presence['selection'] = null;
  const sel = value['selection'];
  if (isObj(sel)) {
    const anchor = parsePosition(sel['anchor']);
    const head = parsePosition(sel['head']);
    if (anchor && head) selection = { anchor, head };
  }
  let pointer: Presence['pointer'] = null;
  const p = value['pointer'];
  if (isObj(p) && typeof p['x'] === 'number' && typeof p['y'] === 'number') {
    if (Number.isFinite(p['x']) && Number.isFinite(p['y'])) pointer = { x: p['x'], y: p['y'] };
  }
  const trimmed = Array.from(name.trim()).slice(0, MAX_NAME_LENGTH).join('');
  return { name: trimmed.length > 0 ? trimmed : 'Anonymous', color, selection, pointer };
}

/** Initials for an avatar chip. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? '?'];
  return letters
    .map((p) => Array.from(p ?? '?')[0] ?? '?')
    .join('')
    .toUpperCase();
}
