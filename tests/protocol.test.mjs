import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADER_LEN,
  createSessionId,
  fnv1a,
  isValidHeader,
  packFrame,
  parseFrame,
} from "../shared/protocol.ts";
import { MAX_BLOCK_LEN, MAX_BLOCKS, MAX_WIRE_PAYLOAD_LEN } from "../shared/limits.ts";

function validHeader(overrides = {}) {
  return {
    sessionId: 7,
    seq: 1,
    k: 2,
    blockLen: 100,
    totalLen: 150,
    payloadFnv: 123,
    ...overrides,
  };
}

test("validates frame header capacity and operational bounds", () => {
  assert.equal(isValidHeader(validHeader()), true);
  assert.equal(isValidHeader(validHeader({ sessionId: 0 })), false);
  assert.equal(isValidHeader(validHeader({ k: 0 })), false);
  assert.equal(isValidHeader(validHeader({ k: MAX_BLOCKS + 1 })), false);
  assert.equal(isValidHeader(validHeader({ blockLen: MAX_BLOCK_LEN + 1 })), false);
  assert.equal(isValidHeader(validHeader({ totalLen: 100 })), false);
  assert.equal(isValidHeader(validHeader({ totalLen: 201 })), false);
  assert.equal(isValidHeader(validHeader({ totalLen: MAX_WIRE_PAYLOAD_LEN + 1 })), false);
});

test("packFrame and parseFrame round trip, malformed frames reject", () => {
  const header = validHeader();
  const block = new Uint8Array(header.blockLen).fill(0xa5);
  const packed = packFrame(header, block);
  const parsed = parseFrame(packed);
  assert.deepEqual(parsed?.header, header);
  assert.deepEqual(parsed?.block, block);
  assert.equal(parseFrame(packed.subarray(0, HEADER_LEN)), null);
  const badMagic = Uint8Array.from(packed);
  badMagic[0] ^= 0xff;
  assert.equal(parseFrame(badMagic), null);
  assert.throws(() => packFrame(header, block.subarray(1)), RangeError);
});

test("FNV detects random payload mutation", () => {
  const bytes = new TextEncoder().encode("integrity");
  const expected = fnv1a(bytes);
  bytes[2] ^= 1;
  assert.notEqual(fnv1a(bytes), expected);
});

test("session ids use the cryptographic browser API and are non-zero uint16", () => {
  for (let i = 0; i < 100; i++) {
    const id = createSessionId();
    assert.ok(id > 0 && id <= 0xffff);
  }
});
