import assert from "node:assert/strict";
import test from "node:test";
import { packEnvelope, parseEnvelope, sanitizeFilename } from "../shared/envelope.ts";
import { MAX_ORIGINAL_FILE_LEN } from "../shared/limits.ts";
import { isValidHeader, parseFrame } from "../shared/protocol.ts";

function seededBytes(length, initialSeed = 0xdec1_2026) {
  let seed = initialSeed >>> 0;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 0xff;
  }
  return bytes;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

test("gzip is selected only when smaller and round trips to original bytes", async () => {
  const compressible = new TextEncoder().encode("optical transfer log line\n".repeat(10_000));
  const packed = await packEnvelope(compressible, "events.log", "text/plain");
  assert.equal(packed.compressed, true);
  assert.ok(packed.wireFileLen < packed.originalLen);
  const parsed = await parseEnvelope(packed.bytes);
  assert.equal(parsed?.filename, "events.log");
  assert.equal(parsed?.mime, "text/plain");
  assert.deepEqual(parsed?.file, compressible);

  const incompressible = seededBytes(8192);
  const raw = await packEnvelope(incompressible, "random.bin", "application/octet-stream");
  assert.equal(raw.compressed, false);
  assert.equal(raw.wireFileLen, raw.originalLen);
  assert.deepEqual((await parseEnvelope(raw.bytes))?.file, incompressible);
});

test("parser rejects truncated metadata, unknown flags, bad lengths, and bad SHA", async () => {
  const original = seededBytes(1024);
  const packed = await packEnvelope(original, "safe.bin", "application/octet-stream");

  const hugeName = Uint8Array.from(packed.bytes);
  view(hugeName).setUint16(6, 60_000, true);
  assert.equal(await parseEnvelope(hugeName), null);

  const unknownFlag = Uint8Array.from(packed.bytes);
  unknownFlag[5] = 0x80;
  assert.equal(await parseEnvelope(unknownFlag), null);

  const noOriginal = Uint8Array.from(packed.bytes);
  view(noOriginal).setUint32(14, 0, true);
  assert.equal(await parseEnvelope(noOriginal), null);

  const noWireFile = Uint8Array.from(packed.bytes);
  view(noWireFile).setUint32(10, 0, true);
  assert.equal(await parseEnvelope(noWireFile), null);

  const rawLengthMismatch = Uint8Array.from(packed.bytes);
  view(rawLengthMismatch).setUint32(14, original.length - 1, true);
  assert.equal(await parseEnvelope(rawLengthMismatch), null);

  const oversizedDeclaration = Uint8Array.from(packed.bytes);
  view(oversizedDeclaration).setUint32(10, 0xffff_ffff, true);
  assert.equal(await parseEnvelope(oversizedDeclaration), null);

  const badSha = Uint8Array.from(packed.bytes);
  badSha[18] ^= 1;
  assert.equal(await parseEnvelope(badSha), null);
});

test("metadata sanitization rejects path/control-only names and MIME controls", async () => {
  assert.equal(sanitizeFilename("../folder/good.txt"), "good.txt");
  assert.equal(sanitizeFilename("..\\"), null);
  assert.equal(sanitizeFilename("\0\u0001\u007f"), null);

  const packed = await packEnvelope(seededBytes(256), "name.bin", "application/octet-stream");
  const controlName = Uint8Array.from(packed.bytes);
  const nameLen = view(controlName).getUint16(6, true);
  controlName.fill(0, 50, 50 + nameLen);
  assert.equal(await parseEnvelope(controlName), null);

  await assert.rejects(
    () => packEnvelope(seededBytes(10), "name.bin", "text/plain\u0000evil"),
    TypeError,
  );
});

test("limited gunzip rejects bombs and truncated streams", async () => {
  const original = new Uint8Array(128 * 1024).fill(0x41);
  const packed = await packEnvelope(original, "large.txt", "text/plain");
  assert.equal(packed.compressed, true);

  const declaredTooSmall = Uint8Array.from(packed.bytes);
  view(declaredTooSmall).setUint32(14, 1024, true);
  assert.equal(await parseEnvelope(declaredTooSmall), null);

  const truncated = packed.bytes.subarray(0, packed.bytes.length - 1).slice();
  const truncatedView = view(truncated);
  truncatedView.setUint32(10, truncatedView.getUint32(10, true) - 1, true);
  assert.equal(await parseEnvelope(truncated), null);
});

test("gzip output exactly at the 50 MiB hard limit is accepted", async () => {
  const original = new Uint8Array(MAX_ORIGINAL_FILE_LEN);
  const packed = await packEnvelope(original, "limit.bin", "application/octet-stream");
  assert.equal(packed.compressed, true);
  const parsed = await parseEnvelope(packed.bytes);
  assert.equal(parsed?.file.length, MAX_ORIGINAL_FILE_LEN);
});

test("randomized parser robustness: 10,000 deterministic buffers never throw", async () => {
  let seed = 0x5eed_1234;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };

  for (let i = 0; i < 10_000; i++) {
    const bytes = new Uint8Array(next() % 513);
    for (let j = 0; j < bytes.length; j++) bytes[j] = next() & 0xff;
    const frame = parseFrame(bytes);
    if (frame) {
      assert.equal(isValidHeader(frame.header), true);
      await assert.doesNotReject(() => parseEnvelope(frame.block));
    }
    await assert.doesNotReject(() => parseEnvelope(bytes));
  }
});
