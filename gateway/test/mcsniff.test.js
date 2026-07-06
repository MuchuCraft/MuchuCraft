// mcsniff.test.js — exhaustive byte-stream tests for the login sniffer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginSniffer, MAX_SNIFF_BYTES } from '../src/mcsniff.js';

// ---------------------------------------------------------------- helpers

/** Minecraft VarInt writer (unsigned, <=5 bytes). */
function varInt(n) {
  const bytes = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** Minecraft String: VarInt byte-length + UTF-8 bytes. */
function mcString(s) {
  const utf8 = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(utf8.length), utf8]);
}

/** Wrap payload parts in a [VarInt length][payload] frame. */
function frame(...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([varInt(payload.length), payload]);
}

function handshake({ protocol = 774, address = 'play.example.com', port = 25565, nextState = 2 } = {}) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  return frame(varInt(0x00), varInt(protocol), mcString(address), portBuf, varInt(nextState));
}

function loginStart(name, uuid = Buffer.alloc(16, 0x42)) {
  return frame(varInt(0x00), mcString(name), uuid);
}

function loginStream(name, hs = {}) {
  return Buffer.concat([handshake({ nextState: 2, ...hs }), loginStart(name)]);
}

const USERNAMES = ['Notch', 'abc', 'a_b_C_1_2_3_XYZ0' /* 16 chars */, 'x_Y_z123', '_1_'];

// ------------------------------------------------------------ happy paths

test('whole-stream handshake+login yields login verdict with the username', () => {
  for (const name of USERNAMES) {
    const r = createLoginSniffer().push(loginStream(name));
    assert.deepEqual(r, { verdict: 'login', username: name }, `username ${name}`);
  }
});

test('nextState 3 (transfer) also routes to Login Start', () => {
  const stream = Buffer.concat([handshake({ nextState: 3 }), loginStart('Notch')]);
  assert.deepEqual(createLoginSniffer().push(stream), { verdict: 'login', username: 'Notch' });
});

test('login stream split at EVERY byte boundary (two parts)', () => {
  for (const name of USERNAMES) {
    const stream = loginStream(name);
    for (let i = 1; i < stream.length; i += 1) {
      const sniffer = createLoginSniffer();
      const first = sniffer.push(stream.subarray(0, i));
      assert.equal(first.verdict, 'pending', `split@${i} (${name}) first part`);
      const second = sniffer.push(stream.subarray(i));
      assert.deepEqual(second, { verdict: 'login', username: name }, `split@${i} (${name})`);
    }
  }
});

test('login stream fed one byte at a time', () => {
  for (const name of USERNAMES) {
    const stream = loginStream(name);
    const sniffer = createLoginSniffer();
    for (let i = 0; i < stream.length - 1; i += 1) {
      assert.equal(sniffer.push(stream.subarray(i, i + 1)).verdict, 'pending', `byte ${i}`);
    }
    const last = sniffer.push(stream.subarray(stream.length - 1));
    assert.deepEqual(last, { verdict: 'login', username: name });
  }
});

test('multi-byte VarInt frame length (long serverAddress), incl. every split', () => {
  const hs = { address: 'x'.repeat(300) }; // handshake frame > 127 bytes -> 2-byte length VarInt
  const stream = loginStream('Steve', hs);
  assert.ok(stream[0] & 0x80, 'test stream must actually use a multi-byte frame length');
  assert.deepEqual(createLoginSniffer().push(stream), { verdict: 'login', username: 'Steve' });
  for (let i = 1; i < stream.length; i += 1) {
    const sniffer = createLoginSniffer();
    assert.equal(sniffer.push(stream.subarray(0, i)).verdict, 'pending', `split@${i}`);
    assert.deepEqual(sniffer.push(stream.subarray(i)), { verdict: 'login', username: 'Steve' });
  }
});

test('handshake+login in separate pushes per frame', () => {
  const sniffer = createLoginSniffer();
  assert.equal(sniffer.push(handshake({ nextState: 2 })).verdict, 'pending');
  assert.deepEqual(sniffer.push(loginStart('Alex')), { verdict: 'login', username: 'Alex' });
});

// ------------------------------------------------------------ status pings

test('status handshake (nextState 1) -> status verdict, no username', () => {
  const r = createLoginSniffer().push(handshake({ nextState: 1 }));
  assert.deepEqual(r, { verdict: 'status' });
});

test('status handshake with the Status Request frame in the same push', () => {
  const stream = Buffer.concat([handshake({ nextState: 1 }), frame(varInt(0x00))]);
  assert.deepEqual(createLoginSniffer().push(stream), { verdict: 'status' });
});

test('status handshake split at every byte boundary', () => {
  const stream = handshake({ nextState: 1 });
  for (let i = 1; i < stream.length; i += 1) {
    const sniffer = createLoginSniffer();
    assert.equal(sniffer.push(stream.subarray(0, i)).verdict, 'pending', `split@${i}`);
    assert.deepEqual(sniffer.push(stream.subarray(i)), { verdict: 'status' });
  }
});

// ---------------------------------------------------------------- latching

test('final verdicts latch: further pushes return the same result', () => {
  const sniffer = createLoginSniffer();
  assert.deepEqual(sniffer.push(loginStream('Notch')), { verdict: 'login', username: 'Notch' });
  assert.deepEqual(sniffer.push(Buffer.from([1, 2, 3])), { verdict: 'login', username: 'Notch' });

  const statusSniffer = createLoginSniffer();
  statusSniffer.push(handshake({ nextState: 1 }));
  assert.deepEqual(statusSniffer.push(frame(varInt(0x00))), { verdict: 'status' });
});

// ---------------------------------------------------------------- garbage

test('malformed frame-length VarInt (6 continuation bytes) -> invalid', () => {
  assert.equal(createLoginSniffer().push(Buffer.alloc(6, 0xff)).verdict, 'invalid');
});

test('zero-length frame -> invalid', () => {
  assert.equal(createLoginSniffer().push(varInt(0)).verdict, 'invalid');
});

test('wrong first packet id -> invalid', () => {
  const bogus = frame(varInt(0x05), varInt(774));
  assert.equal(createLoginSniffer().push(bogus).verdict, 'invalid');
});

test('unknown nextState -> invalid', () => {
  assert.equal(createLoginSniffer().push(handshake({ nextState: 4 })).verdict, 'invalid');
  assert.equal(createLoginSniffer().push(handshake({ nextState: 0 })).verdict, 'invalid');
});

test('truncated handshake fields inside a complete frame -> invalid', () => {
  // frame length covers only the packet id + protocol; string/port/nextState missing
  const truncated = frame(varInt(0x00), varInt(774));
  assert.equal(createLoginSniffer().push(truncated).verdict, 'invalid');
});

test('second frame with wrong packet id after login handshake -> invalid', () => {
  const sniffer = createLoginSniffer();
  sniffer.push(handshake({ nextState: 2 }));
  assert.equal(sniffer.push(frame(varInt(0x07), mcString('Notch'))).verdict, 'invalid');
});

test('username longer than 16 chars -> invalid', () => {
  const sniffer = createLoginSniffer();
  sniffer.push(handshake({ nextState: 2 }));
  assert.equal(sniffer.push(loginStart('a'.repeat(17))).verdict, 'invalid');
});

test('empty username -> invalid', () => {
  const sniffer = createLoginSniffer();
  sniffer.push(handshake({ nextState: 2 }));
  assert.equal(sniffer.push(loginStart('')).verdict, 'invalid');
});

test('login-start string length overrunning the frame -> invalid', () => {
  const sniffer = createLoginSniffer();
  sniffer.push(handshake({ nextState: 2 }));
  // claims a 16-byte name but the frame only carries 2 bytes of it
  const bad = frame(varInt(0x00), varInt(16), Buffer.from('ab'));
  assert.equal(sniffer.push(bad).verdict, 'invalid');
});

// --------------------------------------------------------------- overflow

test('frame declaring a length beyond the cap -> overflow immediately', () => {
  const sniffer = createLoginSniffer();
  const r = sniffer.push(Buffer.concat([varInt(MAX_SNIFF_BYTES + 1), Buffer.from([0x00])]));
  assert.equal(r.verdict, 'overflow');
});

test('accumulating more than 4096 bytes without a verdict -> overflow', () => {
  const sniffer = createLoginSniffer();
  // a frame that stays incomplete forever: declared length 4096, drip-fed
  assert.equal(sniffer.push(varInt(4096)).verdict, 'pending');
  let verdict = 'pending';
  let pushed = varInt(4096).length;
  while (verdict === 'pending' && pushed <= MAX_SNIFF_BYTES + 100) {
    verdict = sniffer.push(Buffer.alloc(512, 0xaa)).verdict;
    pushed += 512;
  }
  assert.equal(verdict, 'overflow');
});

test('single oversized push -> overflow even if bytes might parse', () => {
  assert.equal(createLoginSniffer().push(Buffer.alloc(MAX_SNIFF_BYTES + 1)).verdict, 'overflow');
});

test('overflow latches', () => {
  const sniffer = createLoginSniffer();
  sniffer.push(Buffer.alloc(MAX_SNIFF_BYTES + 1));
  assert.equal(sniffer.push(loginStream('Notch')).verdict, 'overflow');
});

// -------------------------------------------------- protocol number edges

test('multi-byte protocol VarInt values parse (1.21.11 = 774)', () => {
  for (const protocol of [5, 127, 128, 774, 767, 1_000_000]) {
    const r = createLoginSniffer().push(loginStream('Notch', { protocol }));
    assert.deepEqual(r, { verdict: 'login', username: 'Notch' }, `protocol ${protocol}`);
  }
});

test('empty serverAddress and port 0 still parse', () => {
  const r = createLoginSniffer().push(loginStream('Notch', { address: '', port: 0 }));
  assert.deepEqual(r, { verdict: 'login', username: 'Notch' });
});
