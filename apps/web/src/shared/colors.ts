/** Peer colors: distinguishable on #0a0a0a, no purple or pink. The first one is the accent. */
export const PEER_COLORS = [
  '#2dd4bf', // teal (accent)
  '#f5b942', // amber
  '#60a5fa', // sky
  '#fb923c', // orange
  '#4ade80', // green
  '#f87171', // red
  '#facc15', // yellow
  '#38bdf8', // light blue
] as const;

/** Stable color for a replica id (FNV-1a hash into the palette). */
export function colorFor(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PEER_COLORS[(hash >>> 0) % PEER_COLORS.length] ?? PEER_COLORS[0];
}
