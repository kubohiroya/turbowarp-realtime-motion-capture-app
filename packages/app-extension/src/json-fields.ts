/**
 * Reads and writes single fields of JSON text for SB3 scripts.
 *
 * The apps pass calibration results between computers as JSON messages, and Scratch has no way to
 * look inside one. These helpers are deliberately generic — a path in, a string out — so the SB3
 * script keeps the meaning of every field and the shell knows none of them.
 */

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Renders a value the way a Scratch reporter can use it: text as itself, everything else as JSON. */
function render(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Reads the value at a dot-separated path.
 *
 * A numeric segment indexes an array, and `length` on an array reports its length. Anything that is
 * not there reads as an empty string, the same as a failed parse: a script checks for '' and cannot
 * mistake a missing field for a present zero.
 */
export function readJsonPath(json: string, path: string): string {
  const parsed = parse(json);
  if (!parsed.ok) return '';
  let current: unknown = parsed.value;
  const segments = path.trim() === '' ? [] : path.split('.');
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (segment === 'length') {
        current = current.length;
        continue;
      }
      if (!/^\d+$/.test(segment)) return '';
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== 'object' || current === null) return '';
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return '';
    current = (current as Record<string, unknown>)[segment];
  }
  return render(current);
}

/**
 * Returns the object with one field replaced.
 *
 * An empty base starts a new object, so a script can build a message field by field. A base that is
 * not a JSON object returns '' instead of silently discarding what it held.
 */
export function withJsonField(
  json: string,
  key: string,
  value: unknown,
): string {
  const base =
    json.trim() === '' ? { ok: true as const, value: {} } : parse(json);
  if (
    !base.ok ||
    typeof base.value !== 'object' ||
    base.value === null ||
    Array.isArray(base.value)
  ) {
    return '';
  }
  if (key.trim() === '') return '';
  return JSON.stringify({
    ...(base.value as Record<string, unknown>),
    [key]: value,
  });
}

/** Parses a field value given as JSON text. Empty or malformed text becomes null, never a string. */
export function jsonValueOf(text: string): unknown {
  if (text.trim() === '') return null;
  const parsed = parse(text);
  return parsed.ok ? parsed.value : null;
}
