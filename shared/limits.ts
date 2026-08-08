export const MIB = 1024 * 1024;

/** Files above this size require explicit confirmation on both devices. */
export const SOFT_ORIGINAL_LIMIT = 25 * MIB;

/** Hard ceiling for the decompressed file delivered to the user. */
export const MAX_ORIGINAL_FILE_LEN = 50 * MIB;

export const MAX_FILENAME_BYTES = 255;
export const MAX_MIME_BYTES = 127;
export const ENVELOPE_FIXED_LEN = 50;

/**
 * Fountain payload ceiling. The envelope can add at most 432 bytes to a raw
 * 50 MiB file; gzip payloads are only selected when smaller than the raw file.
 */
export const MAX_WIRE_PAYLOAD_LEN =
  MAX_ORIGINAL_FILE_LEN + ENVELOPE_FIXED_LEN + MAX_FILENAME_BYTES + MAX_MIME_BYTES;

export const MAX_BLOCK_LEN = 4096;

/**
 * Operational decoder ceiling, below the uint16 wire maximum. With the
 * default 1445-byte source blocks this still carries the full 50 MiB limit,
 * while bounding decoder arrays and pending-frame bookkeeping.
 */
export const MAX_BLOCKS = 40_000;

export const SESSION_STALL_TIMEOUT_MS = 120_000;
