// mcsniff.js — pure incremental parser for the first Minecraft frames of a
// connection (uncompressed & unencrypted at this stage: offline mode never
// enables encryption and compression starts only after Set Compression).
//
// Wire format (see SPEC.md "Username enforcement"):
//   Frame = [VarInt length][payload]; payload = [VarInt packetId]...
//   Frame 1 — Handshake (id 0x00):
//     [VarInt protocolVersion][String serverAddress][u16 port][VarInt nextState]
//     (String = VarInt byte-length + UTF-8 bytes.)
//   nextState 1 (status ping)            -> verdict 'status' (no username)
//   nextState 2 (login) / 3 (transfer)   -> Frame 2 — Login Start (id 0x00):
//     [String name (<=16 chars)][16-byte UUID] -> verdict 'login' + username
//
// createLoginSniffer().push(buf) -> { verdict, username? } where verdict is:
//   'pending'  — need more bytes
//   'status'   — server-list ping; caller may pipe freely, no username check
//   'login'    — Login Start parsed; `username` carries the extracted name
//   'overflow' — >4096 bytes accumulated without a verdict, or a frame that
//                declares a length beyond the 4096-byte cap. NOTE: the cap is
//                signalled via this verdict; push() NEVER throws.
//   'invalid'  — protocol violation (malformed VarInt, empty frame, wrong
//                packet id, unknown nextState, bad username length, truncated
//                fields inside a complete frame)
//
// Every verdict except 'pending' is FINAL and latches: subsequent push()
// calls return the same result object shape and discard their input.
// The sniffer never consumes/forwards bytes — the caller keeps its own copy
// of everything pushed and flushes it downstream once the verdict allows.

export const MAX_SNIFF_BYTES = 4096;

const MAX_VARINT_BYTES = 5;
const MAX_USERNAME_CHARS = 16;

/**
 * Read a Minecraft VarInt (unsigned, <=5 bytes) at `offset`.
 * @returns {{value:number,size:number}|{incomplete:true}|{malformed:true}}
 */
function readVarInt(buf, offset) {
  let value = 0;
  for (let size = 1; size <= MAX_VARINT_BYTES; size += 1) {
    if (offset + size > buf.length) return { incomplete: true };
    const byte = buf[offset + size - 1];
    value |= (byte & 0x7f) << (7 * (size - 1));
    if ((byte & 0x80) === 0) return { value: value >>> 0, size };
  }
  return { malformed: true };
}

/**
 * Read a Minecraft String (VarInt byte-length + UTF-8) at `offset` inside a
 * COMPLETE frame payload. Any shortfall is a protocol violation, not
 * "pending", because the frame length said all bytes are here.
 * @returns {{value:string,end:number}|null} null on violation
 */
function readString(payload, offset) {
  const len = readVarInt(payload, offset);
  if (len.incomplete || len.malformed) return null;
  const start = offset + len.size;
  const end = start + len.value;
  if (end > payload.length) return null;
  return { value: payload.toString('utf8', start, end), end };
}

export function createLoginSniffer() {
  let buf = Buffer.alloc(0);
  let total = 0; // bytes accumulated while still pending
  let awaitingLogin = false; // handshake seen with nextState 2|3
  let result = null; // latched final verdict

  function latch(verdict, username) {
    result = username === undefined ? { verdict } : { verdict, username };
    buf = Buffer.alloc(0); // free memory; nothing more to parse
    return result;
  }

  /** Parse one complete frame payload. Returns a final result or null. */
  function handleFrame(payload) {
    const packetId = readVarInt(payload, 0);
    if (packetId.incomplete || packetId.malformed || packetId.value !== 0x00) {
      return latch('invalid');
    }
    let off = packetId.size;

    if (!awaitingLogin) {
      // Handshake
      const protocol = readVarInt(payload, off);
      if (protocol.incomplete || protocol.malformed) return latch('invalid');
      off += protocol.size;
      const address = readString(payload, off);
      if (!address) return latch('invalid');
      off = address.end;
      if (off + 2 > payload.length) return latch('invalid'); // u16 port
      off += 2;
      const nextState = readVarInt(payload, off);
      if (nextState.incomplete || nextState.malformed) return latch('invalid');
      if (nextState.value === 1) return latch('status');
      if (nextState.value === 2 || nextState.value === 3) {
        awaitingLogin = true;
        return null; // Login Start comes in the next frame
      }
      return latch('invalid');
    }

    // Login Start
    const name = readString(payload, off);
    if (!name) return latch('invalid');
    const username = name.value;
    if (username.length < 1 || username.length > MAX_USERNAME_CHARS) {
      return latch('invalid');
    }
    // Trailing bytes (16-byte UUID on modern versions) are not validated.
    return latch('login', username);
  }

  /**
   * Feed bytes; returns the current verdict (see module doc).
   * @param {Buffer|Uint8Array} chunk
   */
  function push(chunk) {
    if (result) return result; // latched
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += incoming.length;
    if (total > MAX_SNIFF_BYTES) return latch('overflow');
    buf = buf.length === 0 ? incoming : Buffer.concat([buf, incoming]);

    for (;;) {
      const frameLen = readVarInt(buf, 0);
      if (frameLen.malformed) return latch('invalid');
      if (frameLen.incomplete) break;
      if (frameLen.value === 0) return latch('invalid'); // empty frame
      if (frameLen.value > MAX_SNIFF_BYTES) return latch('overflow');
      const end = frameLen.size + frameLen.value;
      if (buf.length < end) break; // frame not fully buffered yet
      const payload = buf.subarray(frameLen.size, end);
      buf = buf.subarray(end);
      const final = handleFrame(payload);
      if (final) return final;
    }
    return { verdict: 'pending' };
  }

  return { push };
}
