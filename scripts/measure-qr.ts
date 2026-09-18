/**
 * How large a pairing QR code has to appear in a camera image to be read (M-07, QR pairing).
 *
 * The camera app reads the fusion app's Offer off a projection, and the fusion app reads the Answer
 * off a phone held up to its camera. Neither image is a clean scan: the code is small in the frame,
 * blurred by focus and motion, washed out by a projector in a lit room, seen at an angle, and noisy.
 * This renders the code the way a camera would see it under those conditions and decodes it with the
 * same decoder the apps use (jsQR), with the code built by the same encoder and error correction
 * level the pairing extension uses (qrcode, level M). What it reports is the smallest size, in
 * pixels per module and in pixels across, at which each condition still reads.
 *
 * It measures the decoder against a model of the optics, not a camera: a real lens, sensor and
 * projector are for `docs/qr-pairing.md`'s procedure. What this gives is the size to aim for.
 *
 *   node --experimental-strip-types scripts/measure-qr.ts
 *   node --experimental-strip-types scripts/measure-qr.ts --length 1457 --level M --parts 1,2,3,4
 *
 * `--frame 1920x1080` for a 1080p camera, `--turn n` (degrees, default 5) and `--noise n` (fraction
 * of full scale, default 0.01) for the camera's own imperfections, `--clean` for the ideal condition
 * alone, `--json` for the figures.
 */

import jsQR from 'jsqr';
import QRCode from 'qrcode';

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
/** The envelope header each part carries, from the pairing extension's own accounting. */
const ENVELOPE = 362;

function options(argv: readonly string[]) {
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
    turnDegrees: Number(values['turn'] ?? 5),
    // About 2.5 grey levels: what a webcam's own processing leaves on a projected white area. jsQR's
    // binarizer reads much more than this in a flat area as texture, so it is its own sweep.
    noise: Number(values['noise'] ?? 0.01),
    parts: (values['parts'] ?? '1,2,3,4')
      .split(',')
      .map(Number)
      .filter((value) => value > 0),
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

/** Text of a part's length, shaped like the envelope: JSON around a base64url payload. */
function partText(length: number, random: () => number): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const head = '{"protocol":"twqr/1","kind":"offer","partIndex":0,"payload":"';
  const tail = '"}';
  const body = Array.from(
    { length: Math.max(1, length - head.length - tail.length) },
    () => alphabet[Math.floor(random() * alphabet.length)],
  ).join('');
  return `${head}${body}${tail}`;
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

function decodes(
  image: Float32Array,
  text: string,
): { ok: boolean; ms: number } {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let index = 0; index < image.length; index += 1) {
    const level = Math.round(Math.min(1, Math.max(0, image[index]!)) * 255);
    rgba[index * 4] = level;
    rgba[index * 4 + 1] = level;
    rgba[index * 4 + 2] = level;
    rgba[index * 4 + 3] = 255;
  }
  const at = performance.now();
  const result = jsQR(rgba, WIDTH, HEIGHT);
  return { ok: result?.data === text, ms: performance.now() - at };
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
const payload = settings.length - ENVELOPE;
const report = [];
for (const parts of settings.parts) {
  const length =
    parts === 1 ? settings.length : ENVELOPE + Math.ceil(payload / parts);
  const text = partText(length, random);
  const symbol = QRCode.create(text, { errorCorrectionLevel: settings.level });
  const total = symbol.modules.size + QUIET * 2;
  const rows = [];
  const decodeTimes: number[] = [];
  for (const condition of CONDITIONS) {
    // From the largest size that fits down, stopping at the first that fails: the answer is the
    // smallest size below which nothing is tried, so every size above it read.
    let smallest: number | null = null;
    for (const px of [...PX_PER_MODULE].sort((left, right) => right - left)) {
      if (total * px > HEIGHT * 0.95) continue;
      const outcome = decodes(
        render(symbol.modules, px, condition, random),
        text,
      );
      decodeTimes.push(outcome.ms);
      if (!outcome.ok) break;
      smallest = px;
    }
    rows.push({
      ...condition,
      pxPerModule: smallest,
      codeWidthPx: smallest === null ? null : Math.round(smallest * total),
    });
  }
  decodeTimes.sort((left, right) => left - right);
  report.push({
    parts,
    partLength: length,
    level: settings.level,
    version: symbol.version,
    modules: symbol.modules.size,
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
      `\n${entry.parts} part(s) of ${entry.partLength} characters, level ${entry.level}: version ${entry.version}, ${entry.modules} modules (${entry.withQuietZone} with quiet zone), decode ${entry.decodeMedianMs} ms in a ${WIDTH}x${HEIGHT} frame`,
    );
    console.log('  contrast  blur  tilt   smallest that reads');
    for (const row of entry.rows) {
      const size =
        row.pxPerModule === null
          ? `does not read at any size that fits ${HEIGHT} px`
          : `${row.pxPerModule} px/module, ${row.codeWidthPx} px across (${Math.round(((row.codeWidthPx ?? 0) / HEIGHT) * 100)}% of the frame height)`;
      console.log(
        `  ${String(row.contrast).padEnd(8)}  ${String(row.blurPx).padEnd(4)}  ${String(row.tiltDegrees).padEnd(4)}°  ${size}`,
      );
    }
  }
}
