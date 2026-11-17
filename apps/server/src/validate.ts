const ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Room names become file names, so only a conservative ASCII alphabet is allowed: no dots,
 * slashes or other characters that could escape the data directory.
 */
export function isValidRoomName(name: string): boolean {
  return ROOM_NAME.test(name);
}
