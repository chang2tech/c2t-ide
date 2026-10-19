/**
 * Minimal real PNG encoder (RGBA → PNG bytes) using Node's zlib.
 *
 * Used to (a) prove the screenshot pipeline handles raw pixel buffers and
 * (b) generate deterministic fixtures for tests. Production captures arrive
 * already-encoded from CDP/Electron; this module is the format ground truth.
 */
import * as zlib from "zlib";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf: Buffer): number {
  // Lazy table build.
  const table: number[] = (crc32 as unknown as { t?: number[] }).t ?? [];
  if (table.length === 0) {
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as unknown as { t: number[] }).t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Encode raw RGBA pixels (row-major, 4 bytes/px) as a truecolor PNG.
 * Throws on bad dimensions.
 */
export function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePngRgba: invalid dimensions ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePngRgba: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Scanlines with filter byte 0 (None) each row.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** True when buf starts with the PNG magic bytes. */
export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/** True for a JPEG (SOI marker FF D8 FF). */
export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Solid-color RGBA fixture (for tests). */
export function solidRgba(width: number, height: number, r: number, g: number, b: number, a = 255): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}
