import { Doc, type Json, type RelativePosition } from '@flock/crdt';
import { Awareness, WebSocketProvider, type ProviderStatus } from '@flock/sync';
import { Whiteboard, type Tool } from '../board/whiteboard.js';
import { PEER_COLORS } from '../shared/colors.js';
import { byId } from '../shared/dom.js';
import { RemoteCursors } from './cursors.js';
import { LocalStore } from './local-store.js';
import { MAX_NAME_LENGTH, initials, parsePresence } from './presence.js';
import { TextAreaBinding, type RelativeSelection } from './text-binding.js';
import '../shared/theme.css';
import './editor.css';

const DEFAULT_SERVER = 'ws://localhost:5130';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function roomFromHash(): string {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return clean.length > 0 ? clean : 'welcome';
}

function positionJson(p: RelativePosition): Json {
  return {
    anchor: p.anchor ? { replica: p.anchor.replica, seq: p.anchor.seq } : null,
    side: p.side,
  };
}

function selectionJson(s: RelativeSelection | null): Json {
  return s ? { anchor: positionJson(s.anchor), head: positionJson(s.head) } : null;
}

const store = storage();
const room = roomFromHash();
const serverUrl = new URLSearchParams(location.search).get('server') ?? DEFAULT_SERVER;

const doc = new Doc();
const awareness = new Awareness(doc.replicaId);
const local = new LocalStore(store, room);
const restored = local.load(doc);
local.attach(doc);

let name = store?.getItem('flock:name') ?? `Guest ${Math.floor(100 + Math.random() * 900)}`;
const color =
  store?.getItem('flock:color') ??
  PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] ??
  '#2dd4bf';
try {
  store?.setItem('flock:name', name);
  store?.setItem('flock:color', color);
} catch {
  // private mode: names are not remembered
}
awareness.setLocalState({ name, color, selection: null, pointer: null });

// Text editor
const text = doc.getText('notes');
const textarea = byId('notes', HTMLTextAreaElement);
const cursors = new RemoteCursors(byId('cursor-layer', HTMLElement), textarea, text, awareness);
const binding = new TextAreaBinding(textarea, text, doc, (selection) => {
  awareness.setLocalField('selection', selectionJson(selection));
});
doc.on('change', () => {
  cursors.schedule();
  byId('char-count', HTMLElement).textContent = `${text.length} characters`;
});
byId('char-count', HTMLElement).textContent = `${text.length} characters`;

// Whiteboard
const board = new Whiteboard(byId('board', HTMLCanvasElement), doc.getMap('board'), doc, awareness);
board.color = color;
const toolButtons = document.querySelectorAll<HTMLButtonElement>('[data-tool]');
for (const button of toolButtons) {
  button.addEventListener('click', () => {
    board.tool = button.dataset['tool'] as Tool;
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b === button));
  });
}
const swatches = byId('swatches', HTMLElement);
for (const c of PEER_COLORS) {
  const swatch = document.createElement('button');
  swatch.className = 'swatch';
  swatch.style.background = c;
  swatch.title = c;
  swatch.setAttribute('aria-label', `Color ${c}`);
  swatch.setAttribute('aria-pressed', String(c === color));
  swatch.addEventListener('click', () => {
    board.color = c;
    for (const s of swatches.children) s.setAttribute('aria-pressed', String(s === swatch));
  });
  swatches.append(swatch);
}
byId('clear-board', HTMLButtonElement).addEventListener('click', () => {
  if (board.shapeCount > 0 && confirm('Remove every shape for everyone in this room?'))
    board.clear();
});

// Header: room, identity, presence, status
const roomInput = byId('room', HTMLInputElement);
roomInput.value = room;
roomInput.addEventListener('change', () => {
  location.hash = roomInput.value;
  location.reload();
});
const nameInput = byId('name', HTMLInputElement);
nameInput.maxLength = MAX_NAME_LENGTH;
nameInput.value = name;
nameInput.addEventListener('change', () => {
  name = nameInput.value.trim() || name;
  nameInput.value = name;
  try {
    store?.setItem('flock:name', name);
  } catch {
    // ignore
  }
  awareness.setLocalField('name', name);
});

const people = byId('people', HTMLElement);
const renderPeople = (): void => {
  const chips: HTMLElement[] = [];
  for (const [replica, state] of awareness.getStates()) {
    const p = parsePresence(state);
    if (!p) continue;
    const chip = document.createElement('span');
    chip.className = 'avatar';
    chip.style.background = p.color;
    chip.textContent = initials(p.name);
    chip.title = replica === doc.replicaId ? `${p.name} (you)` : p.name;
    if (replica === doc.replicaId) chips.unshift(chip);
    else chips.push(chip);
  }
  people.replaceChildren(...chips);
  byId('people-count', HTMLElement).textContent = `${chips.length} here`;
};
awareness.on('change', renderPeople);
renderPeople();

const status = byId('status', HTMLElement);
const banner = byId('offline-banner', HTMLElement);
byId('server-url', HTMLElement).textContent = serverUrl;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
const showStatus = (s: ProviderStatus, synced: boolean): void => {
  status.className = `pill ${s === 'connected' ? (synced ? 'ok' : 'warn') : s === 'connecting' ? 'warn' : 'bad'}`;
  status.textContent =
    s === 'connected'
      ? synced
        ? 'Synced'
        : 'Syncing'
      : s === 'connecting'
        ? 'Connecting'
        : 'Offline';
  clearTimeout(bannerTimer);
  if (s === 'connected') banner.hidden = true;
  else bannerTimer = setTimeout(() => (banner.hidden = false), 1500);
};
const provider = new WebSocketProvider(serverUrl, room, doc, { awareness });
provider.on('status', (s) => {
  showStatus(s, provider.synced);
});
provider.on('synced', () => {
  showStatus(provider.status, true);
});
showStatus(provider.status, false);
if (restored) {
  const note = byId('restored', HTMLElement);
  note.hidden = false;
  setTimeout(() => (note.hidden = true), 6000);
}

window.addEventListener('pagehide', () => {
  awareness.destroy();
  provider.destroy();
  binding.destroy();
  board.destroy();
  local.destroy();
});
