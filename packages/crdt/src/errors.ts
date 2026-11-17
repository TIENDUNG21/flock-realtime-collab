/** Thrown when an operation is structurally invalid or inconsistent with the document. */
export class InvalidOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOpError';
  }
}

/** Thrown when binary input cannot be decoded. `offset` is the byte position of the problem. */
export class DecodeError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = 'DecodeError';
    this.offset = offset;
  }
}
