import { describe, expect, it } from 'vitest';

import { AvatarAxes, avatarStage } from '../src/avatar-stage.ts';

type Vector = [number, number, number];

/** three.js's matrix for Euler angles in YXZ order: Ry · Rx · Rz. */
function rotate(degrees: Vector, vector: Vector): Vector {
  const [x, y, z] = degrees.map((value) => (value * Math.PI) / 180) as Vector;
  const rz: Vector = [
    Math.cos(z) * vector[0] - Math.sin(z) * vector[1],
    Math.sin(z) * vector[0] + Math.cos(z) * vector[1],
    vector[2],
  ];
  const rx: Vector = [
    rz[0],
    Math.cos(x) * rz[1] - Math.sin(x) * rz[2],
    Math.sin(x) * rz[1] + Math.cos(x) * rz[2],
  ];
  return [
    Math.cos(y) * rx[0] + Math.sin(y) * rx[2],
    rx[1],
    -Math.sin(y) * rx[0] + Math.cos(y) * rx[2],
  ];
}

const expectVector = (actual: Vector, expected: Vector) =>
  actual.forEach((value, index) =>
    expect(value).toBeCloseTo(expected[index] as number, 6),
  );

describe('AvatarAxes', () => {
  it('passes the reference frame through by default, the room being at negative z', () => {
    const axes = AvatarAxes.parse('-y', '-z');
    expect(axes.toAvatar({ x: 1, y: 2, z: -3 })).toEqual({ x: 1, y: 2, z: -3 });
    expect(axes.toScene({ x: 1, y: 2, z: -3 })).toEqual([1, -2, 3]);
  });

  it('turns a frame whose up and audience axes are others', () => {
    // A pattern on the floor, measured with y towards the audience and z down into the floor.
    const axes = AvatarAxes.parse('-z', '+y');
    // One metre up from the floor and one towards the audience: up is y down negative, towards is z negative.
    expect(axes.toAvatar({ x: 0, y: 1, z: -1 })).toEqual({
      x: 0,
      y: -1,
      z: -1,
    });
  });

  it('refuses axes that are not two perpendicular axes', () => {
    expect(() => AvatarAxes.parse('-y', '+y')).toThrow(/perpendicular/u);
    expect(() => AvatarAxes.parse('up', '-z')).toThrow(/one of \+x/u);
  });
});

describe('avatarStage', () => {
  it('puts the pattern where it was measured and a camera in the audience facing it', () => {
    const stage = avatarStage(
      '0,0;2,0;2,1.5;0,1.5',
      4,
      AvatarAxes.parse('-y', '-z'),
    );
    expect(stage).toEqual({
      wallX: 1,
      wallY: -0.75,
      wallZ: 0,
      wallRotationX: 0,
      wallRotationY: 0,
      wallRotationZ: 0,
      wallWidth: 2,
      wallHeight: 1.5,
      cameraX: 1,
      cameraY: -0.75,
      cameraZ: 4,
    });
  });

  it('turns the plane so it lies across, up and facing the way the corners say', () => {
    const axes = AvatarAxes.parse('-z', '+y');
    const stage = avatarStage('0,0;2,0;2,1.5;0,1.5', 4, axes);
    const rotation: Vector = [
      stage.wallRotationX,
      stage.wallRotationY,
      stage.wallRotationZ,
    ];
    const [tl, tr, , bl] = [
      [0, 0],
      [2, 0],
      [2, 1.5],
      [0, 1.5],
    ].map(
      ([x, y]) =>
        axes.toScene({ x: x as number, y: y as number, z: 0 }) as Vector,
    ) as Vector[];
    const across = tr!.map(
      (value, index) => (value - tl![index]!) / 2,
    ) as Vector;
    const up = tl!.map((value, index) => (value - bl![index]!) / 1.5) as Vector;
    expectVector(rotate(rotation, [1, 0, 0]), across);
    expectVector(rotate(rotation, [0, 1, 0]), up);
    const normal = rotate(rotation, [0, 0, 1]);
    expectVector(
      [
        stage.cameraX - stage.wallX,
        stage.cameraY - stage.wallY,
        stage.cameraZ - stage.wallZ,
      ],
      normal.map((value) => value * 4) as Vector,
    );
  });

  it('refuses corners it cannot read and a camera that is not in front', () => {
    const axes = AvatarAxes.parse('-y', '-z');
    expect(() => avatarStage('0,0;2,0;2,1.5', 4, axes)).toThrow(/tlX,tlY/u);
    expect(() => avatarStage('0,0;0,0;0,0;0,0', 4, axes)).toThrow(
      /do not span/u,
    );
    expect(() => avatarStage('0,0;2,0;2,1.5;0,1.5', 0, axes)).toThrow(
      /positive/u,
    );
  });
});
