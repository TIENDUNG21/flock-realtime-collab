/** Version of the binary update format produced by this package. */
export const FORMAT_VERSION = 1;

export {
  compareStamps,
  idEquals,
  idToString,
  isValidReplicaId,
  randomReplicaId,
  MAX_REPLICA_ID_LENGTH,
  type Id,
  type ReplicaId,
  type Stamp,
} from './id.js';
export { LamportClock } from './clock/lamport.js';
export { VectorClock, type Ordering } from './clock/vector.js';
export { LwwMap } from './lww-map.js';
