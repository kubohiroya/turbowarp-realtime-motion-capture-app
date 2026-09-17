import { describe, expect, it } from 'vitest';

import {
  jsonValueOf,
  readJsonPath,
  withJsonField,
} from '../src/json-fields.js';

describe('readJsonPath', () => {
  const message = JSON.stringify({
    type: 'twrmc-sync-result',
    peer: 'camera-1',
    payload: {
      spreadPx: 0.21,
      ok: true,
      points: [{ id: 'tl', u: 1.5 }],
      none: null,
    },
  });

  it('reads text as itself and other values as JSON', () => {
    expect(readJsonPath(message, 'type')).toBe('twrmc-sync-result');
    expect(readJsonPath(message, 'payload.spreadPx')).toBe('0.21');
    expect(readJsonPath(message, 'payload.ok')).toBe('true');
    expect(readJsonPath(message, 'payload.none')).toBe('null');
    expect(readJsonPath(message, 'payload.points.0')).toBe(
      '{"id":"tl","u":1.5}',
    );
  });

  it('indexes arrays and reports their length', () => {
    expect(readJsonPath(message, 'payload.points.length')).toBe('1');
    expect(readJsonPath(message, 'payload.points.0.id')).toBe('tl');
  });

  it('reads the whole document for an empty path', () => {
    expect(readJsonPath('[1,2]', '')).toBe('[1,2]');
  });

  it('reads anything missing or malformed as an empty string', () => {
    expect(readJsonPath(message, 'payload.absent')).toBe('');
    expect(readJsonPath(message, 'payload.points.9')).toBe('');
    expect(readJsonPath(message, 'payload.points.x')).toBe('');
    expect(readJsonPath(message, 'type.deeper')).toBe('');
    expect(readJsonPath('not json', 'type')).toBe('');
  });

  it('does not read inherited properties', () => {
    expect(readJsonPath('{}', 'constructor')).toBe('');
  });
});

describe('withJsonField', () => {
  it('builds an object field by field from an empty start', () => {
    const first = withJsonField('', 'cameraId', 'camera-1');
    const second = withJsonField(first, 'observation', jsonValueOf('{"u":1}'));
    expect(JSON.parse(second)).toEqual({
      cameraId: 'camera-1',
      observation: { u: 1 },
    });
  });

  it('replaces an existing field', () => {
    expect(
      JSON.parse(withJsonField('{"cameraId":"pose"}', 'cameraId', 'camera-2')),
    ).toEqual({
      cameraId: 'camera-2',
    });
  });

  it('refuses a base that is not an object, and a blank key', () => {
    expect(withJsonField('[1]', 'a', 1)).toBe('');
    expect(withJsonField('nope', 'a', 1)).toBe('');
    expect(withJsonField('{}', ' ', 1)).toBe('');
  });

  it('turns empty or malformed JSON values into null rather than text', () => {
    expect(jsonValueOf('')).toBeNull();
    expect(jsonValueOf('{broken')).toBeNull();
  });
});
