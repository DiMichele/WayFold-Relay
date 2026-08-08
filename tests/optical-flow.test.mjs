import assert from "node:assert/strict";
import test from "node:test";
import { packEnvelope, parseEnvelope } from "../shared/envelope.ts";
import { LTDecoder, LTEncoder } from "../shared/fountain.ts";
import { createSessionId, fnv1a, packFrame, parseFrame } from "../shared/protocol.ts";

test("sender and receiver remain synchronized through frame, fountain, and envelope layers", async () => {
  const original = new TextEncoder().encode("end-to-end optical payload\n".repeat(1000));
  const envelope = await packEnvelope(original, "flow.txt", "text/plain");
  const sessionId = createSessionId();
  const blockLen = 480;
  const encoder = new LTEncoder(envelope.bytes, blockLen, sessionId);
  const decoder = new LTDecoder(encoder.k, blockLen, sessionId, envelope.bytes.length);
  const header = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: envelope.bytes.length,
    payloadFnv: fnv1a(envelope.bytes),
  };

  for (let seq = 0; seq < encoder.k * 10 && !decoder.isComplete; seq++) {
    const frame = packFrame({ ...header, seq }, encoder.encode(seq));
    const parsed = parseFrame(frame);
    assert.ok(parsed);
    decoder.addFrame(parsed.header.seq, parsed.block);
  }

  assert.equal(decoder.isComplete, true);
  const payload = decoder.assemble();
  assert.ok(payload);
  assert.equal(fnv1a(payload), header.payloadFnv);
  const result = await parseEnvelope(payload);
  assert.equal(result?.filename, "flow.txt");
  assert.deepEqual(result?.file, original);
});
