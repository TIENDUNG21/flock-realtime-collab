import { realScheduler, type NetworkEvent } from '@flock/sync';
import { TextAreaBinding } from '../editor/text-binding.js';
import { byId } from '../shared/dom.js';
import { LINKS, LabModel, PEERS, type LogEntry, type PeerId } from './lab-model.js';
import '../shared/theme.css';
import './lab.css';

const COLORS: Record<PeerId, string> = { A: '#2dd4bf', B: '#f5b942', C: '#60a5fa' };
const POS: Record<PeerId, { x: number; y: number }> = {
  A: { x: 220, y: 42 },
  B: { x: 70, y: 208 },
  C: { x: 370, y: 208 },
};
const CENTER = { x: 220, y: 153 };
const SVG = 'http://www.w3.org/2000/svg';
const MAX_LOG_ROWS = 160;

let lab: LabModel;
const cleanup: Array<() => void> = [];
let frame = 0;

const svg = byId('topology', SVGSVGElement);

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function linkLabel(a: PeerId, b: PeerId): string {
  return `${a}–${b}`;
}

// ---------- peers ----------

function buildPeers(): void {
  const container = byId('peers', HTMLElement);
  container.replaceChildren();
  for (const peer of PEERS) {
    const card = document.createElement('article');
    card.className = 'peer';
    card.style.setProperty('--peer', COLORS[peer]);
    card.innerHTML = `
      <header class="peer-head">
        <span class="peer-badge">${peer}</span>
        <div class="peer-meta">
          <strong>Peer ${peer}</strong>
          <span class="sv mono" data-sv></span>
        </div>
        <button class="btn small-btn" data-online aria-pressed="true">Online</button>
      </header>
      <textarea spellcheck="false" aria-label="Text of peer ${peer}"></textarea>
      <footer class="peer-foot"><span data-len></span><span data-pending></span></footer>`;
    container.append(card);
    const textarea = card.querySelector('textarea');
    const online = card.querySelector<HTMLButtonElement>('[data-online]');
    if (!textarea || !online) continue;
    const peerDoc = lab.network.peer(peer).doc;
    const binding = new TextAreaBinding(textarea, lab.text(peer), peerDoc);
    online.addEventListener('click', () => {
      if (lab.isOnline(peer)) lab.isolate(peer);
      else
        for (const [a, b] of LINKS) if (a === peer || b === peer) lab.setLink(a, b, { up: true });
    });
    cleanup.push(
      () => {
        binding.destroy();
      },
      peerDoc.on('change', schedule),
    );
  }
}

function renderPeers(): void {
  const cards = byId('peers', HTMLElement).querySelectorAll<HTMLElement>('.peer');
  PEERS.forEach((peer, i) => {
    const card = cards[i];
    if (!card) return;
    const doc = lab.network.peer(peer).doc;
    const sv = doc.stateVector();
    const svText = card.querySelector('[data-sv]');
    if (svText) svText.textContent = PEERS.map((p) => `${p}:${sv.get(p)}`).join('  ');
    const len = card.querySelector('[data-len]');
    if (len) len.textContent = `${lab.text(peer).length} chars`;
    const pending = card.querySelector('[data-pending]');
    if (pending)
      pending.textContent =
        doc.pendingCount > 0 ? `${doc.pendingCount} waiting for dependencies` : '';
    const online = card.querySelector<HTMLButtonElement>('[data-online]');
    if (online) {
      const on = lab.isOnline(peer);
      online.textContent = on ? 'Online' : 'Offline';
      online.setAttribute('aria-pressed', String(on));
      card.classList.toggle('offline', !on);
    }
  });
}

// ---------- network diagram and controls ----------

function buildTopology(): void {
  svg.replaceChildren();
  const linksGroup = svgEl('g', {});
  for (const [a, b] of LINKS) {
    const pa = POS[a];
    const pb = POS[b];
    const line = svgEl('line', {
      x1: pa.x,
      y1: pa.y,
      x2: pb.x,
      y2: pb.y,
      class: 'link-line',
      'data-link': `${a}${b}`,
    });
    const hit = svgEl('line', {
      x1: pa.x,
      y1: pa.y,
      x2: pb.x,
      y2: pb.y,
      class: 'link-hit',
      tabindex: 0,
      role: 'button',
    });
    hit.setAttribute('aria-label', `Toggle link ${linkLabel(a, b)}`);
    const toggle = (): void => {
      lab.setLink(a, b, { up: !lab.link(a, b).up });
    };
    hit.addEventListener('click', toggle);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    // Place the label just outside the triangle so it never sits on the line.
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const out = { x: mid.x - CENTER.x, y: mid.y - CENTER.y };
    const norm = Math.hypot(out.x, out.y) || 1;
    const label = svgEl('text', {
      x: mid.x + (out.x / norm) * 22,
      y: mid.y + (out.y / norm) * 22 + 4,
      class: 'link-label',
      'text-anchor': 'middle',
      'data-label': `${a}${b}`,
    });
    linksGroup.append(line, label, hit);
  }
  svg.append(linksGroup, svgEl('g', { id: 'packets' }));
  for (const peer of PEERS) {
    const { x, y } = POS[peer];
    const g = svgEl('g', { class: 'node' });
    g.append(
      svgEl('circle', {
        cx: x,
        cy: y,
        r: 22,
        fill: '#111413',
        stroke: COLORS[peer],
        'stroke-width': 2.5,
      }),
    );
    const t = svgEl('text', {
      x,
      y: y + 6,
      'text-anchor': 'middle',
      fill: COLORS[peer],
      class: 'node-label',
    });
    t.textContent = peer;
    g.append(t);
    svg.append(g);
  }
}

function buildLinkControls(): void {
  const box = byId('links', HTMLElement);
  box.replaceChildren();
  for (const [a, b] of LINKS) {
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = `
      <button class="btn small-btn" data-up aria-pressed="true">${linkLabel(a, b)}</button>
      <label>Latency <input type="range" min="0" max="2000" step="50" data-latency /><output data-latency-out></output></label>
      <label>Loss <input type="range" min="0" max="0.9" step="0.05" data-loss /><output data-loss-out></output></label>
      <label>Duplicates <input type="range" min="0" max="0.5" step="0.05" data-dup /><output data-dup-out></output></label>`;
    box.append(row);
    const up = row.querySelector<HTMLButtonElement>('[data-up]');
    const latency = row.querySelector<HTMLInputElement>('[data-latency]');
    const loss = row.querySelector<HTMLInputElement>('[data-loss]');
    const dup = row.querySelector<HTMLInputElement>('[data-dup]');
    if (!up || !latency || !loss || !dup) continue;
    const link = lab.link(a, b);
    latency.value = String(link.latencyMs);
    loss.value = String(link.loss);
    dup.value = String(link.duplicate);
    up.addEventListener('click', () => {
      lab.setLink(a, b, { up: !lab.link(a, b).up });
    });
    latency.addEventListener('input', () => {
      lab.setLink(a, b, { latencyMs: Number(latency.value) });
    });
    loss.addEventListener('input', () => {
      lab.setLink(a, b, { loss: Number(loss.value) });
    });
    dup.addEventListener('input', () => {
      lab.setLink(a, b, { duplicate: Number(dup.value) });
    });
  }
}

function renderNetwork(): void {
  const rows = byId('links', HTMLElement).querySelectorAll<HTMLElement>('.link-row');
  LINKS.forEach(([a, b], i) => {
    const link = lab.link(a, b);
    const line = svg.querySelector(`[data-link="${a}${b}"]`);
    line?.setAttribute('class', `link-line ${link.up ? (link.loss > 0 ? 'lossy' : 'up') : 'down'}`);
    const label = svg.querySelector(`[data-label="${a}${b}"]`);
    if (label) {
      label.textContent = link.up
        ? `${link.latencyMs} ms${link.loss > 0 ? ` · ${Math.round(link.loss * 100)}% loss` : ''}`
        : 'cut';
    }
    const row = rows[i];
    if (!row) return;
    const up = row.querySelector('[data-up]');
    up?.setAttribute('aria-pressed', String(link.up));
    const set = (sel: string, text: string): void => {
      const out = row.querySelector(sel);
      if (out) out.textContent = text;
    };
    const sync = (sel: string, value: number): void => {
      const input = row.querySelector<HTMLInputElement>(sel);
      if (input && document.activeElement !== input) input.value = String(value);
    };
    sync('[data-latency]', link.latencyMs);
    sync('[data-loss]', link.loss);
    sync('[data-dup]', link.duplicate);
    set('[data-latency-out]', `${link.latencyMs} ms`);
    set('[data-loss-out]', `${Math.round(link.loss * 100)}%`);
    set('[data-dup-out]', `${Math.round(link.duplicate * 100)}%`);
  });
  const s = lab.stats;
  byId('stats', HTMLElement).textContent =
    `sent ${s.sent} · delivered ${s.delivered} · dropped ${s.dropped} · duplicated ${s.duplicated} · ${(s.bytes / 1024).toFixed(1)} KiB on the wire`;
}

/** Animates one message copy along its link. Lost messages fade out halfway. */
function animatePacket(e: NetworkEvent): void {
  if (e.type !== 'transit' && !(e.type === 'drop' && e.reason === 'loss')) return;
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const from = POS[e.from as PeerId] as { x: number; y: number } | undefined;
  const to = POS[e.to as PeerId] as { x: number; y: number } | undefined;
  const group = svg.querySelector('#packets');
  if (!from || !to || !group) return;
  const kind =
    e.summary.startsWith('update') || /step2 \([1-9]/.test(e.summary)
      ? 'ops'
      : e.summary.startsWith('awareness')
        ? 'presence'
        : 'sync';
  const lost = e.type === 'drop';
  const dot = svgEl('circle', {
    cx: from.x,
    cy: from.y,
    r: kind === 'ops' ? 5 : 3.5,
    class: `packet ${kind}${lost ? ' lost' : ''}`,
  });
  group.append(dot);
  const duration = Math.max(
    120,
    lost ? lab.link(e.from as PeerId, e.to as PeerId).latencyMs / 2 : e.delayMs,
  );
  const end = lost ? 0.5 : 1;
  const start = performance.now();
  const step = (now: number): void => {
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    const p = t * end;
    dot.setAttribute('cx', String(from.x + (to.x - from.x) * p));
    dot.setAttribute('cy', String(from.y + (to.y - from.y) * p));
    if (lost) dot.setAttribute('opacity', String(1 - t));
    if (t < 1) requestAnimationFrame(step);
    else dot.remove();
  };
  requestAnimationFrame(step);
}

// ---------- status and log ----------

function renderStatus(): void {
  const pill = byId('status-pill', HTMLElement);
  const text = byId('status-text', HTMLElement);
  const status = lab.convergence();
  if (status.state === 'converged') {
    pill.className = 'pill ok';
    pill.textContent = 'Converged';
    text.textContent =
      'All three peers hold identical documents: same text, same tombstones, same state vector.';
  } else if (status.state === 'syncing') {
    pill.className = 'pill warn';
    pill.textContent = 'Syncing';
    text.textContent = `${status.inFlight} message${status.inFlight === 1 ? '' : 's'} in flight.`;
  } else {
    pill.className = 'pill bad';
    pill.textContent = 'Diverged';
    const cut = status.cut.map(([a, b]) => linkLabel(a, b)).join(', ');
    text.textContent = `Links cut: ${cut}. Each side keeps editing on its own; restore a path between them and they merge.`;
  }
  const chaos = byId('chaos', HTMLButtonElement);
  chaos.setAttribute('aria-pressed', String(lab.chaosRunning));
  chaos.textContent = lab.chaosRunning ? 'Stop chaos typing' : 'Chaos typing';
}

const pendingRows: LogEntry[] = [];

function logRow(entry: LogEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `log-row ${entry.kind}`;
  const time = document.createElement('span');
  time.className = 'log-time mono';
  time.textContent = `${(entry.time / 1000).toFixed(1)}s`;
  const route = document.createElement('span');
  route.className = 'log-route mono';
  route.textContent = entry.from && entry.to ? `${entry.from} → ${entry.to}` : '';
  const what = document.createElement('span');
  what.className = 'log-what';
  what.textContent = entry.summary;
  const detail = document.createElement('span');
  detail.className = 'log-detail muted';
  detail.textContent = entry.detail;
  li.append(time, route, what, detail);
  return li;
}

function flushLog(): void {
  const list = byId('log', HTMLOListElement);
  const showHandshakes = byId('show-handshakes', HTMLInputElement).checked;
  const rows = pendingRows.splice(0).filter((e) => showHandshakes || !e.handshake);
  for (const entry of rows) list.prepend(logRow(entry));
  while (list.children.length > MAX_LOG_ROWS) list.lastElementChild?.remove();
}

function rebuildLog(): void {
  byId('log', HTMLOListElement).replaceChildren();
  pendingRows.push(...lab.log());
  flushLog();
}

// ---------- lifecycle ----------

function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderStatus();
    renderPeers();
    renderNetwork();
    flushLog();
  });
}

function start(): void {
  lab = new LabModel({ scheduler: realScheduler, seed: Date.now() >>> 0 });
  buildPeers();
  buildTopology();
  buildLinkControls();
  byId('log', HTMLOListElement).replaceChildren();
  cleanup.push(
    lab.on('network', (e) => {
      animatePacket(e);
      schedule();
    }),
    lab.on('log', (entry) => {
      pendingRows.push(entry);
      schedule();
    }),
  );
  lab
    .text('A')
    .insert(
      0,
      'Type in any peer. Cut a link (or press "Isolate A"), keep typing on both sides, then heal the network and watch the three texts become identical.\n',
    );
  runScenario(new URLSearchParams(location.search).get('scenario'));
  schedule();
}

/** Optional starting situations, so a specific case can be shared as a link. */
function runScenario(name: string | null): void {
  if (name === 'partition') {
    setTimeout(() => {
      lab.isolate('A');
      lab.text('A').insert(0, 'A, offline: written while the links to A were cut.\n');
      const b = lab.text('B');
      b.insert(b.length, 'B, meanwhile: edited on the other side of the cut.\n');
    }, 1200);
  } else if (name === 'chaos') {
    lab.setLink('A', 'B', { loss: 0.3, duplicate: 0.1 });
    lab.setLink('B', 'C', { latencyMs: 900 });
    lab.startChaos();
  }
}

function stop(): void {
  for (const off of cleanup.splice(0)) off();
  lab.destroy();
  pendingRows.length = 0;
}

byId('chaos', HTMLButtonElement).addEventListener('click', () => {
  if (lab.chaosRunning) lab.stopChaos();
  else lab.startChaos();
  schedule();
});
byId('split', HTMLButtonElement).addEventListener('click', () => {
  lab.isolate('A');
});
byId('heal', HTMLButtonElement).addEventListener('click', () => {
  lab.heal();
});
byId('reset', HTMLButtonElement).addEventListener('click', () => {
  stop();
  start();
});
byId('show-handshakes', HTMLInputElement).addEventListener('change', rebuildLog);

start();
