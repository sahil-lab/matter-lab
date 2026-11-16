import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { root } from '../../qa/process.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), result.length - 4);
  return result;
}

export function makeIconPng(size = 256) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const centres = [[0.28, 0.31], [0.72, 0.31], [0.5, 0.7]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x / size;
      const py = y / size;
      const node = centres.some(([cx, cy]) => Math.hypot(px - cx, py - cy) < 0.105);
      const bond = (Math.abs(py - 0.31) < 0.022 && px > 0.28 && px < 0.72)
        || (Math.abs(px - (0.28 + (py - 0.31) * 0.22 / 0.39)) < 0.025 && py > 0.31 && py < 0.7)
        || (Math.abs(px - (0.72 - (py - 0.31) * 0.22 / 0.39)) < 0.025 && py > 0.31 && py < 0.7);
      const color = node ? [143, 234, 209] : bond ? [65, 139, 142] : [7, 27, 34];
      const offset = y * (size * 4 + 1) + 1 + 4 * x;
      pixels.set([...color, 255], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function createIcons() {
  const directory = join(root, 'apps', 'desktop', 'src-tauri', 'icons');
  await mkdir(directory, { recursive: true });
  const png = makeIconPng();
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  await writeFile(join(directory, 'icon.png'), png);
  await writeFile(join(directory, 'icon.ico'), Buffer.concat([ico, png]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await createIcons();
