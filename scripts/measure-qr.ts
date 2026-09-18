/**
 * How large a pairing QR code has to appear in a camera image to be read (M-07, QR pairing).
 *
 * The camera app reads the fusion app's Offer off a projection, and the fusion app reads the Answer
 * off a phone held up to its camera. Neither image is a clean scan: the code is small in the frame,
 * blurred by focus and motion, washed out by a projector in a lit room, seen at an angle, and noisy.
 * This renders the code the way a camera would see it under those conditions and decodes it with the
 * same decoder the apps use (zxing-cpp, which turbowarp-jsqr 0.4.0 wraps), with the codes built the
 * way the pairing extension builds them: one Structured Append sequence per message, from
 * `@kubohiroya/qrcode-structured-append`, capped at a QR version, level M. What it reports, per
 * version cap, is how many codes a message takes and the smallest size, in pixels per module and in
 * pixels across, at which each condition still reads one of them.
 *
 * It measures the decoder against a model of the optics, not a camera: a real lens, sensor and
 * projector are for `docs/qr-pairing.md`'s procedure. What this gives is the size to aim for.
 *
 *   node --experimental-strip-types scripts/measure-qr.ts
 *   node --experimental-strip-types scripts/measure-qr.ts --length 1457 --level M --versions 15,20,40
 *
 * `--frame 1920x1080` for a 1080p camera, `--turn n` (degrees, default 5) and `--noise n` (fraction
 * of full scale, default 0.01) for the camera's own imperfections, `--clean` for the ideal image
 * alone (full contrast, no blur, no tilt, and no turn or noise unless given), `--json` for the
 * figures.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createStructuredAppend } from '@kubohiroya/qrcode-structured-append';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

type Level = 'L' | 'M' | 'Q' | 'H';

interface Condition {
  readonly blurPx: number;
  readonly contrast: number;
  readonly tiltDegrees: number;
}

let WIDTH = 1280;
let HEIGHT = 720;
/** The pairing extension keeps the quiet zone, four modules each side. */
const QUIET = 4;
/**
 * The header line a pairing message carries in front of the code (`twqr/2`): protocol, session,
 * peers, kind, message ID, reply-to, timestamp, length and hash. About 300 characters.
 */
const HEADER =
  'twqr/2\n{"sessionId":"00000000-0000-4000-8000-000000000000","senderPeerId":"fusion","targetPeerId":"camera-1","kind":"offer","messageId":"00000000-0000-4000-8000-000000000000.AAAAAAAAAAAA","replyTo":"","createdAt":1789000000000,"messageLength":1457,"messageHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n';

function options(input: readonly string[]) {
  // `pnpm run measure:qr -- --json` passes the `--` through.
  const argv = input.filter((argument) => argument !== '--');
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) continue;
    if (argument === '--clean' || argument === '--json') {
      values[argument.slice(2)] = '';
      continue;
    }
    values[argument.slice(2)] = argv[index + 1] ?? '';
    index += 1;
  }
  const level = (values['level'] ?? 'M') as Level;
  if (!['L', 'M', 'Q', 'H'].includes(level))
    throw new Error(`Unknown level ${level}`);
  return {
    // An Offer measured in the browser was 1,457 characters, an Answer 1,334 to 1,508.
    length: Number(values['length'] ?? 1457),
    level,
    // The camera's frame, and the two things every camera image has: a slight turn, and noise.
    frame: values['frame'] ?? '1280x720',
    // `--clean` is the ideal image: no turn and no noise unless asked for, besides the one condition.
    turnDegrees: Number(values['turn'] ?? ('clean' in values ? 0 : 5)),
    // About 2.5 grey levels: what a webcam's own processing leaves on a projected white area. Raise it
    // to see how much noise a dim venue, and a camera turning its gain up, costs.
    noise: Number(values['noise'] ?? ('clean' in values ? 0 : 0.01)),
    // The pairing extension caps offers at 15 and answers at 20; 40 is one code for the whole offer.
    versions: (values['versions'] ?? '15,20,40')
      .split(',')
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 40),
    json: 'json' in values,
  };
}

const settings = options(process.argv.slice(2));
[WIDTH, HEIGHT] = settings.frame.split('x').map(Number) as [number, number];

/**
 * A seeded generator, so a run can be repeated exactly.
 *
 * mulberry32 rather than a plain linear congruential generator: the noise takes two draws per pixel,
 * and an LCG's successive draws are correlated enough to lay a pattern over the image that a real
 * sensor does not have — and that the decoder, reasonably, cannot read through.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A pairing message of the given code length: the header line, then a base64url-like code. */
function messageText(length: number, random: () => number): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const code = Array.from(
    { length: Math.max(1, length) },
    () => alphabet[Math.floor(random() * alphabet.length)],
  ).join('');
  return `${HEADER}${code}`;
}

/**
 * The camera's view of the code, as grey levels in [0, 1].
 *
 * The code, with its quiet zone, sits in the middle of the frame on a darker surround. It is turned
 * slightly in the image plane and tilted away from the camera about its vertical axis, then projected
 * through a pinhole; each pixel samples it four times, is blurred, and gets sensor noise.
 */
function render(
  modules: { size: number; get(row: number, column: number): number | boolean },
  pxPerModule: number,
  condition: Condition,
  random: () => number,
): Float32Array {
  const total = modules.size + QUIET * 2;
  const high = 0.5 + condition.contrast / 2;
  const low = 0.5 - condition.contrast / 2;
  const surround = 0.3;
  const tilt = (condition.tiltDegrees * Math.PI) / 180;
  const turn = (settings.turnDegrees * Math.PI) / 180;
  const focal = WIDTH;
  const image = new Float32Array(WIDTH * HEIGHT);
  const sample = (u: number, v: number): number => {
    // Undo the projection onto the tilted plane, then the in-plane turn.
    const x = (u * focal) / (focal * Math.cos(tilt) - u * Math.sin(tilt));
    const y = (v * (focal + x * Math.sin(tilt))) / focal;
    const px = x * Math.cos(turn) + y * Math.sin(turn);
    const py = -x * Math.sin(turn) + y * Math.cos(turn);
    const column = Math.floor(px / pxPerModule + total / 2);
    const row = Math.floor(py / pxPerModule + total / 2);
    if (row < 0 || column < 0 || row >= total || column >= total)
      return surround;
    const moduleRow = row - QUIET;
    const moduleColumn = column - QUIET;
    if (
      moduleRow < 0 ||
      moduleColumn < 0 ||
      moduleRow >= modules.size ||
      moduleColumn >= modules.size
    ) {
      return high;
    }
    return modules.get(moduleRow, moduleColumn) ? low : high;
  };
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      const u = column - WIDTH / 2;
      const v = row - HEIGHT / 2;
      image[row * WIDTH + column] =
        (sample(u + 0.25, v + 0.25) +
          sample(u + 0.75, v + 0.25) +
          sample(u + 0.25, v + 0.75) +
          sample(u + 0.75, v + 0.75)) /
        4;
    }
  }
  const blurred = condition.blurPx > 0 ? blur(image, condition.blurPx) : image;
  // Sensor noise, as a fraction of full scale, left after the camera's own processing.
  for (let index = 0; index < blurred.length; index += 1) {
    const gaussian =
      Math.sqrt(-2 * Math.log(random() || 1e-9)) *
      Math.cos(2 * Math.PI * random());
    blurred[index] = blurred[index]! + gaussian * settings.noise;
  }
  return blurred;
}

/** A separable Gaussian blur, standing in for focus and motion. */
function blur(image: Float32Array, sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, index) =>
    Math.exp(-((index - radius) ** 2) / (2 * sigma * sigma)),
  );
  const sum = kernel.reduce((total, value) => total + value, 0);
  const weights = kernel.map((value) => value / sum);
  const pass = (source: Float32Array, horizontal: boolean): Float32Array => {
    const target = new Float32Array(source.length);
    for (let row = 0; row < HEIGHT; row += 1) {
      for (let column = 0; column < WIDTH; column += 1) {
        let value = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          const r = horizontal
            ? row
            : Math.min(HEIGHT - 1, Math.max(0, row + offset));
          const c = horizontal
            ? Math.min(WIDTH - 1, Math.max(0, column + offset))
            : column;
          value += source[r * WIDTH + c]! * weights[offset + radius]!;
        }
        target[row * WIDTH + column] = value;
      }
    }
    return target;
  };
  return pass(pass(image, true), false);
}

/** Node has no ImageData; the decoder only reads these fields. */
class ImageDataLike {
  public readonly colorSpace = 'srgb';
  public readonly data: Uint8ClampedArray;
  public readonly width: number;
  public readonly height: number;
  public constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
(globalThis as { ImageData?: unknown }).ImageData ??= ImageDataLike;

const require = createRequire(import.meta.url);
await prepareZXingModule({
  overrides: {
    wasmBinary: readFileSync(
      require.resolve('zxing-wasm/reader/zxing_reader.wasm'),
    ).buffer,
  },
  fireImmediately: true,
});

/** Whether the decoder reads the code as the expected symbol of the sequence, and how long it took. */
async function decodes(
  image: Float32Array,
  expected: { readonly index: number; readonly bytes: Uint8Array },
): Promise<{ ok: boolean; ms: number }> {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let index = 0; index < image.length; index += 1) {
    const level = Math.round(Math.min(1, Math.max(0, image[index]!)) * 255);
    rgba[index * 4] = level;
    rgba[index * 4 + 1] = level;
    rgba[index * 4 + 2] = level;
    rgba[index * 4 + 3] = 255;
  }
  const at = performance.now();
  // The same options turbowarp-jsqr reads camera frames with.
  const [result] = await readBarcodes(
    new ImageData(rgba, WIDTH, HEIGHT) as never,
    { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 },
  );
  const ms = performance.now() - at;
  const ok =
    result !== undefined &&
    result.isValid &&
    result.sequenceIndex === expected.index &&
    result.bytes.length === expected.bytes.length &&
    result.bytes.every((byte, index) => byte === expected.bytes[index]);
  return { ok, ms };
}

const PX_PER_MODULE = [2, 2.5, 3, 3.5, 4, 5, 6, 8];
const CONDITIONS: Condition[] = [];
const clean = process.argv.includes('--clean');
for (const contrast of clean ? [1] : [1, 0.5, 0.25]) {
  for (const blurPx of clean ? [0] : [0, 1, 2]) {
    for (const tiltDegrees of clean ? [0] : [0, 30, 45])
      CONDITIONS.push({ blurPx, contrast, tiltDegrees });
  }
}

const random = seeded(1);
const message = messageText(settings.length, random);
const report = [];
for (const maxVersion of settings.versions) {
  const symbols = createStructuredAppend(message, {
    level: settings.level,
    maxVersion,
  });
  // The shares are balanced, so every code of a sequence has the same version; the first stands
  // for them all.
  const symbol = symbols[0]!;
  const modules = {
    size: symbol.size,
    get: (row: number, column: number) => symbol.isDark(column, row),
  };
  const total = symbol.size + QUIET * 2;
  const rows: (Condition & {
    pxPerModule: number | null;
    codeWidthPx: number | null;
    sizesRead: number;
    sizesTried: number;
    readAt: number[];
  })[] = [];
  const decodeTimes: number[] = [];
  for (const condition of CONDITIONS) {
    // Every size that fits. A decoder can miss at one size and read at the next, so the sizes that
    // read are kept, not only the smallest: the smallest says how small a code can get, the count
    // how dependable that is.
    const read: number[] = [];
    const tried: number[] = [];
    for (const px of PX_PER_MODULE) {
      if (total * px > HEIGHT * 0.95) continue;
      tried.push(px);
      const outcome = await decodes(
        render(modules, px, condition, random),
        symbol,
      );
      decodeTimes.push(outcome.ms);
      if (outcome.ok) read.push(px);
    }
    const smallest = read[0] ?? null;
    rows.push({
      ...condition,
      pxPerModule: smallest,
      codeWidthPx: smallest === null ? null : Math.round(smallest * total),
      sizesRead: read.length,
      sizesTried: tried.length,
      readAt: read,
    });
  }
  decodeTimes.sort((left, right) => left - right);
  // How many of the conditions read at each size: the size to aim for is where this is high.
  const bySize = PX_PER_MODULE.filter((px) => total * px <= HEIGHT * 0.95).map(
    (px) => ({
      pxPerModule: px,
      codeWidthPx: Math.round(px * total),
      conditionsRead: rows.filter((row) => row.readAt.includes(px)).length,
    }),
  );
  report.push({
    maxVersion,
    codes: symbols.length,
    messageLength: message.length,
    level: settings.level,
    version: symbol.version,
    modules: symbol.size,
    bySize,
    withQuietZone: total,
    decodeMedianMs: Math.round(
      decodeTimes[Math.floor(decodeTimes.length / 2)] ?? 0,
    ),
    rows,
  });
}

if (settings.json) {
  console.log(
    JSON.stringify(
      {
        frame: `${WIDTH}x${HEIGHT}`,
        turnDegrees: settings.turnDegrees,
        noise: settings.noise,
        report,
      },
      null,
      2,
    ),
  );
} else {
  for (const entry of report) {
    console.log(
      `\nversion cap ${entry.maxVersion}: ${entry.codes} code(s) for ${entry.messageLength} characters, level ${entry.level}: version ${entry.version}, ${entry.modules} modules (${entry.withQuietZone} with quiet zone), decode ${entry.decodeMedianMs} ms in a ${WIDTH}x${HEIGHT} frame`,
    );
    console.log(
      `  conditions read, of ${CONDITIONS.length}, by size: ${entry.bySize.map((size) => `${size.pxPerModule} px/module (${size.codeWidthPx} px) ${size.conditionsRead}`).join(', ')}`,
    );
    console.log('  contrast  blur  tilt   smallest that reads');
    for (const row of entry.rows) {
      const size =
        row.pxPerModule === null
          ? `does not read at any size that fits ${HEIGHT} px`
          : `${row.pxPerModule} px/module, ${row.codeWidthPx} px across (${Math.round(((row.codeWidthPx ?? 0) / HEIGHT) * 100)}% of the frame height); ${row.sizesRead} of ${row.sizesTried} sizes read`;
      console.log(
        `  ${String(row.contrast).padEnd(8)}  ${String(row.blurPx).padEnd(4)}  ${String(row.tiltDegrees).padEnd(4)}°  ${size}`,
      );
    }
  }
}
