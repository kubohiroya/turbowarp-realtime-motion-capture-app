/**
 * Synthetic scenes for evaluating the 3D service (#34, stage 2).
 *
 * A scene is generated from a seed, so a figure measured today can be measured again tomorrow on the
 * same input. It produces both the 2D frames a service receives and the 3D truth those frames came
 * from, which is what makes an error figure meaningful.
 *
 * What it models is what the later stages are judged on: several people seen by several cameras, each
 * camera seeing them from its own place, with keypoint noise, people walking out of a camera's view,
 * occlusion spells where a camera loses a person entirely, and tracking IDs that are per camera and
 * change when a tracker loses someone. What it does not model — lens distortion, rolling shutter,
 * clock error between cameras — is left to the venue recordings, and listed here so nobody reads a
 * good synthetic figure as a good venue figure.
 */

import {COCO_17_KEYPOINT_IDS, type Coco17KeypointId, type PoseFrame2D, type ServiceCamera, type ServiceConfiguration} from './contracts.ts';
import type {Session, SessionEvent, TruthFrame, TruthPerson} from './session.ts';
import {SESSION_SCHEMA, SESSION_VERSION} from './session.ts';

export interface SceneOptions {
  readonly seed: number;
  readonly cameras: number;
  readonly persons: number;
  readonly seconds: number;
  readonly frameRate: number;
  /** Standard deviation of keypoint noise, in pixels. */
  readonly noisePx: number;
  /** Probability per camera per second that a person is lost for a spell. */
  readonly occlusionRate: number;
  /** Probability per camera per second that a tracker gives a person a new ID. */
  readonly identitySwitchRate: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly startedAtUs: number;
}

export const DEFAULT_SCENE: SceneOptions = Object.freeze({
  seed: 1,
  cameras: 4,
  persons: 3,
  seconds: 10,
  frameRate: 30,
  noisePx: 1.5,
  occlusionRate: 0.05,
  identitySwitchRate: 0.02,
  imageWidth: 1280,
  imageHeight: 720,
  startedAtUs: 1_789_000_000_000_000
});

type Vector3 = readonly [number, number, number];

/**
 * A standing person, as offsets from the hips in meters.
 *
 * Reference coordinates are the ones the placement solve uses: x to the right, y downwards, z away
 * from the reference plane towards the room. A person stands on y = 0 with their head above, so head
 * offsets are negative.
 */
const SKELETON: Readonly<Record<Coco17KeypointId, Vector3>> = Object.freeze({
  nose: [0, -0.72, 0.08],
  left_eye: [0.03, -0.75, 0.07],
  right_eye: [-0.03, -0.75, 0.07],
  left_ear: [0.07, -0.74, 0],
  right_ear: [-0.07, -0.74, 0],
  left_shoulder: [0.18, -0.55, 0],
  right_shoulder: [-0.18, -0.55, 0],
  left_elbow: [0.22, -0.28, 0.02],
  right_elbow: [-0.22, -0.28, 0.02],
  left_wrist: [0.24, -0.02, 0.05],
  right_wrist: [-0.24, -0.02, 0.05],
  left_hip: [0.11, 0, 0],
  right_hip: [-0.11, 0, 0],
  left_knee: [0.12, 0.45, 0.02],
  right_knee: [-0.12, 0.45, 0.02],
  left_ankle: [0.12, 0.88, 0],
  right_ankle: [-0.12, 0.88, 0]
});

/** The hips' height above the floor, so the floor is y = HIP_HEIGHT in reference coordinates. */
const HIP_HEIGHT = 0.95;

export interface SyntheticScene {
  readonly session: Session;
  readonly options: SceneOptions;
}

export function generateScene(overrides: Partial<SceneOptions> = {}): SyntheticScene {
  const options: SceneOptions = {...DEFAULT_SCENE, ...overrides};
  if (options.cameras < 2) throw new Error('A scene needs at least two cameras to be triangulated.');
  const random = mulberry32(options.seed);
  const cameras = placeCameras(options);
  const configuration: ServiceConfiguration = {
    implementation: 'stub-normal',
    referenceId: 'synthetic-room',
    cameras: cameras.map((camera) => camera.service)
  };
  const frameCount = Math.max(1, Math.round(options.seconds * options.frameRate));
  const frameIntervalUs = Math.round(1_000_000 / options.frameRate);
  const paths = Array.from({length: options.persons}, (_, index) => personPath(index, options.persons));

  const events: SessionEvent[] = [];
  const truth: TruthFrame[] = [];
  const sequences = new Map<string, number>();
  /** Per camera and person: the tracking ID in use, and how long an occlusion spell still lasts. */
  const trackingIds = new Map<string, string>();
  const hiddenUntil = new Map<string, number>();
  let nextTrackingId = 1;

  for (let index = 0; index < frameCount; index += 1) {
    const timestampUs = options.startedAtUs + index * frameIntervalUs;
    const seconds = index / options.frameRate;
    const persons = paths.map((path, person) => ({
      personId: `person-${person + 1}`,
      joints: jointsOf(path, seconds)
    }));
    const truthPersons: TruthPerson[] = persons.map((person) => ({
      personId: person.personId,
      joints: person.joints.map(({id, position}) => ({
        id,
        x: position[0],
        y: position[1],
        z: position[2],
        cameraIds: cameras
          .filter((camera) => !isHidden(hiddenUntil, camera.service.cameraId, person.personId, seconds))
          .filter((camera) => project(camera, position, options) !== undefined)
          .map((camera) => camera.service.cameraId)
      }))
    }));
    truth.push({timestampUs, persons: truthPersons});

    for (const camera of cameras) {
      const cameraId = camera.service.cameraId;
      const visible: Array<PoseFrame2D['persons'][number]> = [];
      for (const person of persons) {
        const key = `${cameraId}/${person.personId}`;
        if (random() < options.occlusionRate / options.frameRate && !isHidden(hiddenUntil, cameraId, person.personId, seconds)) {
          // Lost for half a second to two seconds, as a tracker loses somebody behind another.
          hiddenUntil.set(key, seconds + 0.5 + random() * 1.5);
        }
        if (isHidden(hiddenUntil, cameraId, person.personId, seconds)) {
          trackingIds.delete(key);
          continue;
        }
        if (!trackingIds.has(key) || random() < options.identitySwitchRate / options.frameRate) {
          trackingIds.set(key, `track-${nextTrackingId++}`);
        }
        const keypoints = person.joints.map(({id, position}) => {
          const projected = project(camera, position, options);
          if (projected === undefined) return {id, x: 0, y: 0, score: 0};
          return {
            id,
            x: round3(projected[0] + gaussian(random) * options.noisePx),
            y: round3(projected[1] + gaussian(random) * options.noisePx),
            score: round3(0.7 + random() * 0.29)
          };
        });
        if (keypoints.every((keypoint) => keypoint.score === 0)) continue;
        visible.push({trackingId: trackingIds.get(key) ?? 'track-0', score: 0.9, keypoints});
      }
      // A tracker reports whoever it found, in its own order.
      shuffle(visible, random);
      const sequence = sequences.get(cameraId) ?? 0;
      sequences.set(cameraId, sequence + 1);
      events.push({
        type: 'frame2d',
        atUs: timestampUs + 20_000,
        cameraId,
        frame: {
          schema: 'twrmc/pose-frame-2d',
          version: 1,
          cameraId,
          peerId: 'synthetic',
          sequence,
          captureTimestampUs: timestampUs,
          frameWidth: options.imageWidth,
          frameHeight: options.imageHeight,
          calibrationId: camera.service.model.intrinsicProfileId,
          persons: visible
        }
      });
    }
    events.push({type: 'requestPose3d', atUs: timestampUs + 25_000});
  }

  return {
    options,
    session: {
      schema: SESSION_SCHEMA,
      version: SESSION_VERSION,
      producer: `synthetic/walk-v1 seed=${options.seed} cameras=${options.cameras} persons=${options.persons}`,
      configuration,
      events,
      truth
    }
  };
}

interface SceneCamera {
  readonly service: ServiceCamera;
  /** Rotation and translation taken apart once, so projection does not re-read the 4x4 each time. */
  readonly rotation: readonly number[];
  readonly translation: Vector3;
}

/** Cameras on an arc in front of the reference plane, all looking at the middle of the room. */
function placeCameras(options: SceneOptions): SceneCamera[] {
  const target: Vector3 = [0, 0, 4];
  return Array.from({length: options.cameras}, (_, index) => {
    const angle = -Math.PI / 3 + (index / Math.max(1, options.cameras - 1)) * ((2 * Math.PI) / 3);
    const eye: Vector3 = [Math.sin(angle) * 5, -1.4, 4 - Math.cos(angle) * 5];
    const {rotation, translation} = lookAt(eye, target);
    const cameraId = `camera-${index + 1}`;
    return {
      rotation,
      translation,
      service: {
        cameraId,
        model: {
          intrinsics: {fx: 900, fy: 900, cx: (options.imageWidth - 1) / 2, cy: (options.imageHeight - 1) / 2, skew: 0},
          distortion: {model: 'none', coefficients: []},
          intrinsicProfileId: `synthetic-${cameraId}`,
          imageWidth: options.imageWidth,
          imageHeight: options.imageHeight
        },
        cameraFromReference: [
          rotation[0]!, rotation[1]!, rotation[2]!, translation[0],
          rotation[3]!, rotation[4]!, rotation[5]!, translation[1],
          rotation[6]!, rotation[7]!, rotation[8]!, translation[2],
          0, 0, 0, 1
        ],
        timeCorrespondence: null
      }
    };
  });
}

/** The rotation and translation that take a reference point into the camera's own frame. */
function lookAt(eye: Vector3, target: Vector3): {rotation: number[]; translation: Vector3} {
  const forward = normalize(subtract(target, eye));
  // y is downwards in reference coordinates, so down is the natural second axis.
  const down: Vector3 = [0, 1, 0];
  const right = normalize(cross(down, forward));
  const trueDown = cross(forward, right);
  const rotation = [right[0], right[1], right[2], trueDown[0], trueDown[1], trueDown[2], forward[0], forward[1], forward[2]];
  const translation: Vector3 = [
    -(rotation[0]! * eye[0] + rotation[1]! * eye[1] + rotation[2]! * eye[2]),
    -(rotation[3]! * eye[0] + rotation[4]! * eye[1] + rotation[5]! * eye[2]),
    -(rotation[6]! * eye[0] + rotation[7]! * eye[1] + rotation[8]! * eye[2])
  ];
  return {rotation, translation};
}

/** Image coordinates, or nothing when the point is behind the camera or outside the frame. */
function project(camera: SceneCamera, point: Vector3, options: SceneOptions): [number, number] | undefined {
  const r = camera.rotation;
  const x = r[0]! * point[0] + r[1]! * point[1] + r[2]! * point[2] + camera.translation[0];
  const y = r[3]! * point[0] + r[4]! * point[1] + r[5]! * point[2] + camera.translation[1];
  const z = r[6]! * point[0] + r[7]! * point[1] + r[8]! * point[2] + camera.translation[2];
  if (z <= 0.2) return undefined;
  const {intrinsics} = camera.service.model;
  const u = intrinsics.fx * (x / z) + intrinsics.cx;
  const v = intrinsics.fy * (y / z) + intrinsics.cy;
  if (u < 0 || v < 0 || u > options.imageWidth - 1 || v > options.imageHeight - 1) return undefined;
  return [u, v];
}

interface PersonPath {
  readonly start: Vector3;
  readonly velocity: Vector3;
  readonly phase: number;
}

/** People walk across the room on their own line, far enough apart to be told apart by geometry. */
function personPath(index: number, count: number): PersonPath {
  const lane = index - (count - 1) / 2;
  return {
    start: [lane * 1.2 - 1.5, HIP_HEIGHT, 3.2 + lane * 0.6],
    velocity: [0.45 * (index % 2 === 0 ? 1 : -1), 0, 0.1 * (index % 3 === 0 ? 1 : -1)],
    phase: index * 0.7
  };
}

/** Joint positions at a moment: the walk moves the body, the arms and knees swing with the stride. */
function jointsOf(path: PersonPath, seconds: number): Array<{id: Coco17KeypointId; position: Vector3}> {
  const stride = Math.sin(2 * Math.PI * (seconds * 1.8 + path.phase));
  const bob = Math.abs(Math.cos(2 * Math.PI * (seconds * 1.8 + path.phase))) * 0.03;
  const hips: Vector3 = [
    path.start[0] + path.velocity[0] * seconds,
    path.start[1] - bob,
    path.start[2] + path.velocity[2] * seconds
  ];
  return COCO_17_KEYPOINT_IDS.map((id) => {
    const offset = SKELETON[id];
    const swing = id.endsWith('wrist') || id.endsWith('elbow') ? stride * 0.18 : id.endsWith('knee') || id.endsWith('ankle') ? -stride * 0.12 : 0;
    const side = id.startsWith('left') ? 1 : -1;
    return {
      id,
      position: [hips[0] + offset[0], hips[1] + offset[1], hips[2] + offset[2] + swing * side] as Vector3
    };
  });
}

function isHidden(hiddenUntil: Map<string, number>, cameraId: string, personId: string, seconds: number): boolean {
  const until = hiddenUntil.get(`${cameraId}/${personId}`);
  return until !== undefined && seconds < until;
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function normalize(value: Vector3): Vector3 {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Deterministic, small, and good enough for noise: the seed is what matters here. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap]!, values[index]!];
  }
}
