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
export { Doc, LOCAL_ORIGIN, type ChangeEvent, type DocOptions, type UpdateEvent } from './doc.js';
export { DecodeError, InvalidOpError } from './errors.js';
export { freezeJson, MAX_JSON_DEPTH, type Json } from './json.js';
export {
  opLength,
  validateOp,
  type DeleteOp,
  type IdRange,
  type InsertOp,
  type Op,
  type SetOp,
} from './ops.js';
export { TextType, type RelativePosition } from './types/text.js';
export { MapType } from './types/map.js';
