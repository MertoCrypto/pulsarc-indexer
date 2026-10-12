import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN, decodeString } from '../src/labelCore.mjs';

// ---------------------------------------------------------------------------
// ABI-encoding helper
// Encodes a JS string as an eth_call `string` return:
//   [32 bytes: offset] [32 bytes: length] [ceil(len/32)*32 bytes: utf8 data]
// Default offset is 0x20 (32); pass `offsetOverride` to test non-standard layouts.
// ---------------------------------------------------------------------------
function abiEncodeString(str, offsetOverride) {
  const data = Buffer.from(str, 'utf8');
  const len = data.length;

  // Pad data to next 32-byte boundary
  const paddedLen = Math.ceil(len / 32) * 32 || 32; // at least 32 bytes even for len=0
  const dataPadded = Buffer.alloc(paddedLen);
  data.copy(dataPadded);

  const offset = offsetOverride !== undefined ? offsetOverride : 0x20;

  // For offset=0x20 (32): layout is [offset-word][len-word][data]
  // For a custom offset we still lay out the same structure but the first word
  // points at a different position within the buffer.
  if (offset === 0x20) {
    // Standard layout
    const buf = Buffer.alloc(32 + 32 + paddedLen);
    buf.writeBigUInt64BE(BigInt(0), 0);        // high bytes of offset word = 0
    buf.writeBigUInt64BE(BigInt(0x20), 24);    // offset = 32 in last 8 bytes of word
    buf.writeBigUInt64BE(BigInt(len), 56);     // len in last 8 bytes of second word
    dataPadded.copy(buf, 64);
    return '0x' + buf.toString('hex');
  } else {
    // Custom offset: place a zero-pad prefix so offset points correctly.
    // Total buffer: offset bytes of zeros + 32-byte len word + paddedLen bytes of data
    // First word (bytes 0-31) = offset value
    const totalSize = 32 + offset + 32 + paddedLen; // offset-word + zeroPad(offset-32 bytes) + len-word + data
    // Simpler: just allocate offset + 32 + paddedLen, put the offset-word first
    const buf = Buffer.alloc(32 + (offset - 32) + 32 + paddedLen, 0);
    // Write offset in first 32-byte word
    const offsetBig = BigInt(offset);
    // Write as big-endian 32-byte value
    for (let i = 0; i < 32; i++) {
      buf[i] = 0;
    }
    // Write offset value into last bytes of first word
    const offsetHex = offsetBig.toString(16).padStart(64, '0');
    for (let i = 0; i < 32; i++) {
      buf[i] = parseInt(offsetHex.slice(i * 2, i * 2 + 2), 16);
    }
    // Write length at position `offset` (as 32-byte big-endian)
    const lenHex = BigInt(len).toString(16).padStart(64, '0');
    for (let i = 0; i < 32; i++) {
      buf[offset + i] = parseInt(lenHex.slice(i * 2, i * 2 + 2), 16);
    }
    // Write data at position `offset + 32`
    dataPadded.copy(buf, offset + 32);
    return '0x' + buf.toString('hex');
  }
}

// Shorthand: produce a hex string of `n` zero bytes prefixed with '0x'
function zeroHex(n) {
  return '0x' + '00'.repeat(n);
}

// ---------------------------------------------------------------------------
// KNOWN
// ---------------------------------------------------------------------------

describe('KNOWN', () => {
  it('every key is a lowercase 0x + 40 hex address', () => {
    const keyRe = /^0x[0-9a-f]{40}$/;
    for (const key of Object.keys(KNOWN)) {
      assert.match(key, keyRe, `key "${key}" does not match expected format`);
    }
  });

  it('every value has a non-empty name string', () => {
    for (const [key, val] of Object.entries(KNOWN)) {
      assert.equal(typeof val.name, 'string', `${key}.name is not a string`);
      assert.ok(val.name.length > 0, `${key}.name is empty`);
    }
  });

  it('every value has a non-empty kind string', () => {
    for (const [key, val] of Object.entries(KNOWN)) {
      assert.equal(typeof val.kind, 'string', `${key}.kind is not a string`);
      assert.ok(val.kind.length > 0, `${key}.kind is empty`);
    }
  });

  it('no duplicate keys after lowercasing', () => {
    const lower = Object.keys(KNOWN).map(k => k.toLowerCase());
    const unique = new Set(lower);
    assert.equal(unique.size, lower.length, 'duplicate keys after lowercasing');
  });

  it('contains exactly 5 known entries', () => {
    assert.equal(Object.keys(KNOWN).length, 5);
  });

  it('Permit2 entry is correct', () => {
    const entry = KNOWN['0x000000000022d473030f116ddee9f6b43ac78ba3'];
    assert.deepEqual(entry, { name: 'Permit2', kind: 'infra' });
  });

  it('ERC-4337 EntryPoint v0.7 entry is correct', () => {
    const entry = KNOWN['0x0000000071727de22e5e9d8baf0edac6f37da032'];
    assert.deepEqual(entry, { name: 'ERC-4337 EntryPoint v0.7', kind: 'account-abstraction' });
  });

  it('ERC-4337 EntryPoint v0.6 entry is correct', () => {
    const entry = KNOWN['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789'];
    assert.deepEqual(entry, { name: 'ERC-4337 EntryPoint v0.6', kind: 'account-abstraction' });
  });

  it('Multicall3 entry is correct', () => {
    const entry = KNOWN['0xca11bde05977b3631167028862be2a173976ca11'];
    assert.deepEqual(entry, { name: 'Multicall3', kind: 'infra' });
  });

  it('USDC at 0x3600...0000 entry is correct', () => {
    const entry = KNOWN['0x3600000000000000000000000000000000000000'];
    assert.deepEqual(entry, { name: 'USDC', kind: 'token' });
  });
});

// ---------------------------------------------------------------------------
// decodeString — null / short-circuit cases
// ---------------------------------------------------------------------------

describe('decodeString – null/undefined/empty inputs', () => {
  it('null -> null', () => {
    assert.equal(decodeString(null), null);
  });

  it('undefined -> null', () => {
    assert.equal(decodeString(undefined), null);
  });

  it("'' -> null", () => {
    assert.equal(decodeString(''), null);
  });

  it("'0x' -> null", () => {
    assert.equal(decodeString('0x'), null);
  });
});

describe('decodeString – hex too short', () => {
  it('hex shorter than 130 chars -> null (129 chars)', () => {
    // 129-char string starting with 0x
    const short = '0x' + '00'.repeat(63) + '0'; // 2 + 126 + 1 = 129
    assert.equal(short.length, 129);
    assert.equal(decodeString(short), null);
  });

  it('hex exactly 130 chars is not rejected by length check alone', () => {
    // 130 chars = '0x' + 128 hex chars = 64 bytes
    // offset=0x20, len-field=0 -> returns null for len===0, but NOT for the length check
    // We just assert it doesn't throw (returns null for some reason)
    const hex = '0x' + '00'.repeat(64);
    assert.equal(hex.length, 130);
    const result = decodeString(hex);
    assert.equal(result, null); // len===0 -> null
  });
});

// ---------------------------------------------------------------------------
// decodeString – non-hex garbage
// ---------------------------------------------------------------------------

describe('decodeString – non-hex garbage', () => {
  it('non-hex characters (all g chars, length >= 130) -> null, never throws', () => {
    const garbage = '0x' + 'g'.repeat(128);
    assert.equal(garbage.length, 130);
    assert.equal(decodeString(garbage), null);
  });

  it('mixed garbage long string -> null, never throws', () => {
    const garbage = '0x' + 'zq!@#$%^&*()'.repeat(20);
    assert.equal(decodeString(garbage), null);
  });
});

// ---------------------------------------------------------------------------
// decodeString – normal ASCII
// ---------------------------------------------------------------------------

describe('decodeString – normal ASCII strings', () => {
  it('"USD Coin" decodes correctly', () => {
    const hex = abiEncodeString('USD Coin');
    assert.equal(decodeString(hex), 'USD Coin');
  });

  it('"Wrapped Ether" decodes correctly', () => {
    const hex = abiEncodeString('Wrapped Ether');
    assert.equal(decodeString(hex), 'Wrapped Ether');
  });

  it('"USDC" decodes correctly', () => {
    assert.equal(decodeString(abiEncodeString('USDC')), 'USDC');
  });

  it('single printable ASCII char decodes correctly', () => {
    assert.equal(decodeString(abiEncodeString('A')), 'A');
  });

  it('all printable ASCII chars 0x20-0x7e in one string', () => {
    let s = '';
    for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
    // 95 chars total > 80, so take a 10-char slice from 0x21 to avoid leading space
    // (decodeString trims surrounding spaces, so we start from 0x21 '!')
    const slice = s.slice(1, 11); // chars 0x21..0x2a, no leading/trailing space
    assert.equal(decodeString(abiEncodeString(slice)), slice);
  });
});

// ---------------------------------------------------------------------------
// decodeString – trimming
// ---------------------------------------------------------------------------

describe('decodeString – trims surrounding spaces', () => {
  it('leading spaces are trimmed', () => {
    assert.equal(decodeString(abiEncodeString('  Hello')), 'Hello');
  });

  it('trailing spaces are trimmed', () => {
    assert.equal(decodeString(abiEncodeString('Hello  ')), 'Hello');
  });

  it('both sides trimmed', () => {
    assert.equal(decodeString(abiEncodeString('  USD Coin  ')), 'USD Coin');
  });

  it('string that is only spaces (length <= 80) trims to empty -> documents current behaviour', () => {
    // "   " passes the regex (spaces are in range) and len <= 80
    // trim() produces "" but the return is ""; it's a non-null empty string
    const hex = abiEncodeString('   ');
    const result = decodeString(hex);
    // Current behaviour: returns '' (the trimmed result) — not null
    assert.equal(result, '');
  });
});

// ---------------------------------------------------------------------------
// decodeString – length boundary
// ---------------------------------------------------------------------------

describe('decodeString – length boundaries', () => {
  it('length 0 -> null', () => {
    // Manually craft a hex with len word = 0
    // offset=0x20, len=0, no data needed
    // We need hex length >= 130: 2 + 128 = 130 chars = 64 bytes
    const buf = Buffer.alloc(64, 0);
    // offset word = 0x20
    buf[31] = 0x20;
    // len word = 0 (already zero)
    const hex = '0x' + buf.toString('hex');
    assert.equal(hex.length, 130);
    assert.equal(decodeString(hex), null);
  });

  it('length 1 -> decodes (single char)', () => {
    assert.equal(decodeString(abiEncodeString('X')), 'X');
  });

  it('exactly 80 chars -> decodes OK', () => {
    const s = 'A'.repeat(80);
    assert.equal(decodeString(abiEncodeString(s)), s);
  });

  it('81 chars -> null', () => {
    const s = 'A'.repeat(81);
    assert.equal(decodeString(abiEncodeString(s)), null);
  });

  it('79 chars -> decodes OK', () => {
    const s = 'B'.repeat(79);
    assert.equal(decodeString(abiEncodeString(s)), s);
  });
});

// ---------------------------------------------------------------------------
// decodeString – unicode (within allowed range U+0020 – U+FFFD)
// ---------------------------------------------------------------------------

describe('decodeString – unicode within allowed range', () => {
  it('Euro sign U+20AC decodes correctly', () => {
    const s = 'Euro\u20AC'; // 3-byte UTF-8 sequence for €
    // UTF-8 length = 4 + 3 = 7 bytes, within 80
    assert.equal(decodeString(abiEncodeString(s)), s);
  });

  it('CJK character U+4E2D decodes correctly', () => {
    const s = 'Token\u4E2D'; // 5 + 3 = 8 bytes
    assert.equal(decodeString(abiEncodeString(s)), s);
  });

  it('U+00A9 copyright sign decodes correctly', () => {
    const s = '\u00A9 Circle';
    assert.equal(decodeString(abiEncodeString(s)), s);
  });

  it('U+FFFD replacement char decodes correctly (boundary of allowed range)', () => {
    const s = 'test\uFFFD';
    assert.equal(decodeString(abiEncodeString(s)), s);
  });
});

// ---------------------------------------------------------------------------
// decodeString – control characters and newlines -> null
// ---------------------------------------------------------------------------

describe('decodeString – control characters and newlines -> null', () => {
  it('string with newline \\n -> null', () => {
    assert.equal(decodeString(abiEncodeString('hello\nworld')), null);
  });

  it('string with carriage return \\r -> null', () => {
    assert.equal(decodeString(abiEncodeString('hello\rworld')), null);
  });

  it('string with tab \\t -> null', () => {
    assert.equal(decodeString(abiEncodeString('hello\tworld')), null);
  });

  it('string with null byte \\x00 -> null', () => {
    assert.equal(decodeString(abiEncodeString('hello\x00world')), null);
  });

  it('string with bell \\x07 -> null', () => {
    assert.equal(decodeString(abiEncodeString('he\x07llo')), null);
  });

  it('string with US \\x1f (highest control below 0x20) -> null', () => {
    assert.equal(decodeString(abiEncodeString('\x1fABC')), null);
  });
});

// ---------------------------------------------------------------------------
// decodeString – non-string-shaped data (never throws)
// ---------------------------------------------------------------------------

describe('decodeString – non-string-shaped data -> null, never throws', () => {
  it('bytes32-style return (uint256 value, no offset/len layout) -> null', () => {
    // A uint256 return value: 32 bytes of data, but interpreted as offset
    // offset would be a huge number -> subarray returns empty -> BigInt('0x') throws -> caught -> null
    // We need hex length >= 130, so pad to 64 bytes
    const buf = Buffer.alloc(64, 0);
    // Simulate a bytes32 return: just raw data, no ABI tuple layout
    // offset word = some large non-32 value like 0xdeadbeef
    buf[28] = 0xde;
    buf[29] = 0xad;
    buf[30] = 0xbe;
    buf[31] = 0xef;
    const hex = '0x' + buf.toString('hex');
    assert.equal(decodeString(hex), null);
  });

  it('huge offset (larger than buffer) -> null, never throws', () => {
    const buf = Buffer.alloc(64, 0);
    // offset = 0xFFFFFFFF (way beyond the 64-byte buffer)
    buf[28] = 0xff;
    buf[29] = 0xff;
    buf[30] = 0xff;
    buf[31] = 0xff;
    const hex = '0x' + buf.toString('hex');
    assert.equal(decodeString(hex), null);
  });

  it('huge length field that overflows the buffer -> null, never throws', () => {
    // offset = 0x20 (valid), but len = 0xFFFFFF (huge) -> len > 80 -> null
    const buf = Buffer.alloc(64, 0);
    buf[31] = 0x20; // offset = 32
    buf[60] = 0x00;
    buf[61] = 0xff;
    buf[62] = 0xff;
    buf[63] = 0xff; // len = 0xFFFFFF >> 80 -> null
    const hex = '0x' + buf.toString('hex');
    assert.equal(decodeString(hex), null);
  });

  it('all 0xff bytes (giant length/offset) -> null, never throws', () => {
    const buf = Buffer.alloc(128, 0xff);
    const hex = '0x' + buf.toString('hex');
    assert.equal(decodeString(hex), null);
  });

  it('offset = 0 (first word is 0) -> reads length at bytes[0..32] which is 0x20 -> documents current behaviour', () => {
    // offset = 0 means length is read from bytes[0..32] itself
    // bytes[0..32] = 0x0000...0020 = 32 -> len = 32 (which is <= 80)
    // then data is from bytes[0+32..0+32+32] = bytes[32..64]
    // This is unusual but the function handles it
    const buf = Buffer.alloc(128, 0);
    buf[31] = 0x20; // first 32 bytes = offset = 32... but offset IS 0 here
    // To set offset=0: first word must be 0x00
    // So buf[0..31] = 0 -> offset = 0
    // len = bytes[0..32] = same first word = 0 -> null (len===0)
    buf[31] = 0x00; // ensure first word = 0 -> offset=0 -> len from bytes[0..32] = 0 -> null
    const hex = '0x' + buf.toString('hex');
    assert.equal(decodeString(hex), null);
  });
});

// ---------------------------------------------------------------------------
// decodeString – offset other than 0x20 (valid but shifted layout)
// ---------------------------------------------------------------------------

describe('decodeString – non-standard offset (valid shifted layout)', () => {
  it('offset 0x40 (64) decoded correctly', () => {
    const s = 'Circle';
    const hex = abiEncodeString(s, 0x40);
    assert.equal(decodeString(hex), s);
  });

  it('offset 0x60 (96) decoded correctly', () => {
    const s = 'Arc';
    const hex = abiEncodeString(s, 0x60);
    assert.equal(decodeString(hex), s);
  });
});

// ---------------------------------------------------------------------------
// decodeString – exact output assertions for known real-world values
// ---------------------------------------------------------------------------

describe('decodeString – exact output assertions', () => {
  it('decodes "USD Coin" to exactly "USD Coin"', () => {
    assert.equal(decodeString(abiEncodeString('USD Coin')), 'USD Coin');
  });

  it('decodes "USDC" to exactly "USDC"', () => {
    assert.equal(decodeString(abiEncodeString('USDC')), 'USDC');
  });

  it('decodes 80-char string to exactly that string', () => {
    const s = 'x'.repeat(80);
    assert.equal(decodeString(abiEncodeString(s)), s);
  });

  it('decodes "  USD Coin  " to exactly "USD Coin" (trim)', () => {
    assert.equal(decodeString(abiEncodeString('  USD Coin  ')), 'USD Coin');
  });
});
