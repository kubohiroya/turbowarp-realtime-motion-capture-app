/**
 * How the service's reference frame meets the avatars' scene.
 *
 * The reference frame is the projected pattern's (#M-08): the wall is z = 0, and the operator
 * measures the corners with the top-left corner at the origin, x to the right and y downwards, so
 * z points into the wall and the room is at negative z. The avatar blocks read 3D joints in
 * Kalidokit's axes: x to the viewer's right, y down, z away from the viewer. A viewer in the room
 * facing the wall sees exactly the reference frame, so by default the joints pass unchanged. A
 * venue that measured the corners another way names which reference axis points up and which
 * points towards the audience, and the joints are turned to match.
 *
 * A-Frame's y is up and its camera looks down -z, so a point of the avatars' axes is at
 * (x, -y, -z) in the scene.
 */

type Vector = readonly [number, number, number];

export type AxisName = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export const DEFAULT_UP_AXIS: AxisName = '-y';
export const DEFAULT_AUDIENCE_AXIS: AxisName = '-z';

const AXES: Record<AxisName, Vector> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

export class AvatarAxes {
  /** Rows: the avatars' x, y and z axes, in reference coordinates. */
  private readonly rows: readonly [Vector, Vector, Vector];

  public constructor(up: AxisName, audience: AxisName) {
    const upward = AXES[up];
    const towards = AXES[audience];
    if (dot(upward, towards) !== 0) {
      throw new Error(
        `The up axis ${up} and the audience axis ${audience} must be perpendicular.`,
      );
    }
    const down = scale(upward, -1);
    const away = scale(towards, -1);
    this.rows = [cross(down, away), down, away];
  }

  public static parse(up: string, audience: string): AvatarAxes {
    const name = (value: string, label: string): AxisName => {
      const trimmed = value.trim() as AxisName;
      if (!(trimmed in AXES))
        throw new Error(
          `${label} must be one of ${Object.keys(AXES).join(', ')}.`,
        );
      return trimmed;
    };
    return new AvatarAxes(
      name(up, 'The up axis'),
      name(audience, 'The audience axis'),
    );
  }

  /** A reference point in the avatars' axes. */
  public toAvatar(point: { x: number; y: number; z: number }): {
    x: number;
    y: number;
    z: number;
  } {
    const p: Vector = [point.x, point.y, point.z];
    return {
      x: dot(this.rows[0], p),
      y: dot(this.rows[1], p),
      z: dot(this.rows[2], p),
    };
  }

  /** A reference point in the scene. */
  public toScene(point: { x: number; y: number; z: number }): Vector {
    const avatar = this.toAvatar(point);
    return [avatar.x, -avatar.y, -avatar.z];
  }
}

export interface AvatarStage {
  /** The wall's centre, in the scene. */
  readonly wallX: number;
  readonly wallY: number;
  readonly wallZ: number;
  /** A-Frame rotation, degrees in its YXZ order, that turns a plane's face to the audience. */
  readonly wallRotationX: number;
  readonly wallRotationY: number;
  readonly wallRotationZ: number;
  readonly wallWidth: number;
  readonly wallHeight: number;
  /** Where a camera in the audience, facing the wall's centre, stands. */
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
}

/**
 * The projected pattern as a plane in the scene, and a camera `distanceM` in front of its centre
 * looking at it. `corners` is the text the operator entered for the placement reference:
 * `tlX,tlY;trX,trY;brX,brY;blX,blY`, metres on the wall.
 */
export function avatarStage(
  corners: string,
  distanceM: number,
  axes: AvatarAxes,
): AvatarStage {
  const points = corners
    .split(';')
    .map((pair) => pair.split(',').map((value) => Number(value.trim())));
  if (
    points.length !== 4 ||
    points.some((point) => point.length !== 2 || !point.every(Number.isFinite))
  ) {
    throw new Error(
      'Corners must be tlX,tlY;trX,trY;brX,brY;blX,blY in metres.',
    );
  }
  if (!(Number.isFinite(distanceM) && distanceM > 0)) {
    throw new Error('The camera distance must be a positive number of metres.');
  }
  const [tl, tr, br, bl] = points.map(([x, y]) =>
    axes.toScene({ x: x as number, y: y as number, z: 0 }),
  ) as [Vector, Vector, Vector, Vector];
  const center = scale(add(add(tl, tr), add(br, bl)), 0.25);
  const across = sub(tr, tl);
  const upward = sub(tl, bl);
  const width = length(across);
  const height = length(upward);
  if (!(width > 0 && height > 0))
    throw new Error('The corners do not span a wall.');
  const ex = scale(across, 1 / width);
  // The wall's own up, made square to its across; the corners are measured, not exact.
  const ey = normalise(sub(upward, scale(ex, dot(upward, ex))));
  const ez = cross(ex, ey);
  const rotation = eulerYxzDegrees(ex, ey, ez);
  const camera = add(center, scale(ez, distanceM));
  return {
    wallX: round(center[0]),
    wallY: round(center[1]),
    wallZ: round(center[2]),
    wallRotationX: round(rotation[0]),
    wallRotationY: round(rotation[1]),
    wallRotationZ: round(rotation[2]),
    wallWidth: round(width),
    wallHeight: round(height),
    cameraX: round(camera[0]),
    cameraY: round(camera[1]),
    cameraZ: round(camera[2]),
  };
}

/** Euler angles, degrees, in three.js's YXZ order, of the rotation whose columns are ex, ey, ez. */
function eulerYxzDegrees(ex: Vector, ey: Vector, ez: Vector): Vector {
  // m[row][column]
  const m = (row: number, column: number) => [ex, ey, ez][column]![row]!;
  const m23 = m(1, 2);
  const x = Math.asin(-Math.max(-1, Math.min(1, m23)));
  let y: number;
  let z: number;
  if (Math.abs(m23) < 0.9999999) {
    y = Math.atan2(m(0, 2), m(2, 2));
    z = Math.atan2(m(1, 0), m(1, 1));
  } else {
    y = Math.atan2(-m(2, 0), m(0, 0));
    z = 0;
  }
  const degrees = (radians: number) => (radians * 180) / Math.PI;
  return [degrees(x), degrees(y), degrees(z)];
}

function dot(a: Vector, b: Vector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vector, b: Vector): Vector {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function add(a: Vector, b: Vector): Vector {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vector, b: Vector): Vector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vector, factor: number): Vector {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function length(a: Vector): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalise(a: Vector): Vector {
  return scale(a, 1 / length(a));
}

function round(value: number): number {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
