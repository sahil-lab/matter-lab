/**
 * SHA-256 (FIPS 180-4), synchronous and without dependencies, so that an experiment can be hashed inside
 * `runExperiment` in a browser or a worker (the Web Crypto API is asynchronous).
 *
 * The round constants and the initial hash value are not typed in. They are computed from their
 * definition in the standard, exactly, with integer arithmetic: the first 32 bits of the fractional parts of
 * the cube roots of the first 64 primes, and of the square roots of the first 8 primes.
 */

/** UTF-8 encoding of a string. An unpaired surrogate is encoded as U+FFFD, as the Encoding Standard prescribes. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

/** Largest integer whose square (degree 2) or cube (degree 3) does not exceed `value`. */
function integerRoot(value: bigint, degree: 2 | 3): bigint {
  const power = BigInt(degree);
  let low = 0n;
  let high = 1n;
  while (high ** power <= value) high <<= 1n;
  while (high - low > 1n) {
    const middle = (low + high) >> 1n;
    if (middle ** power <= value) low = middle;
    else high = middle;
  }
  return low;
}

let tables: { readonly k: Uint32Array; readonly h: Uint32Array } | undefined;

function constants(): { readonly k: Uint32Array; readonly h: Uint32Array } {
  if (tables) return tables;
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p !== 0)) primes.push(n);
  // floor(root(p) * 2^32) = floor(root(p * 2^(32 * degree))); its low 32 bits are the fraction that is wanted.
  const fraction32 = (prime: number, degree: 2 | 3): number => Number(integerRoot(BigInt(prime) << BigInt(32 * degree), degree) & 0xffffffffn);
  tables = {
    k: Uint32Array.from(primes, (p) => fraction32(p, 3)),
    h: Uint32Array.from(primes.slice(0, 8), (p) => fraction32(p, 2)),
  };
  return tables;
}

const rotateRight = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 digest of a byte sequence, as 32 bytes. */
export function sha256Bytes(message: Uint8Array): Uint8Array {
  const { k, h: initial } = constants();
  const h = Uint32Array.from(initial);
  const length = message.length;
  // Room for the message, the 0x80 marker and the 64-bit length, rounded up to whole 64-byte blocks.
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bits / 0x100000000));
  view.setUint32(paddedLength - 4, bits >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + 4 * i);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let last = h[7]!;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (last + sum1 + choice + k[i]! + w[i]!) | 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) | 0;
      last = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + last;
  }
  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) out.setUint32(4 * i, h[i]!);
  return digest;
}

/** SHA-256 digest as 64 lower-case hexadecimal digits. A string is hashed as its UTF-8 encoding. */
export function sha256Hex(input: string | Uint8Array): string {
  const digest = sha256Bytes(typeof input === 'string' ? utf8Bytes(input) : input);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
