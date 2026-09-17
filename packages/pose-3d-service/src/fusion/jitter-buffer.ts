import {COCO_17_KEYPOINT_IDS} from '../contracts.ts';
import type {Coco17KeypointId, Keypoint2D, PoseFrame2D, PoseFrame2DPerson} from '../contracts.ts';
import type {
  SynchronizedCameraSample,
  SynchronizedKeypoint2D,
  SynchronizedPerson2D,
  SynchronizedPoseSample,
} from './types.ts';

export type IngestOutcome = "accepted" | "duplicate" | "late";

export interface JitterBufferOptions {
  /** Ring slots retained per camera. */
  capacityPerCamera: number;
  /** Out-of-order tolerance measured back from the newest buffered frame. */
  jitterWindowUs: number;
  /** Longest single-sided hold when the requested instant has no bracket. */
  maxHoldUs: number;
  /** Widest bracket that is still interpolated instead of held. */
  maxGapUs: number;
  /** Keypoints below this score are treated as occluded. */
  minKeypointScore: number;
}

export const DEFAULT_JITTER_BUFFER_OPTIONS: JitterBufferOptions = {
  capacityPerCamera: 120,
  jitterWindowUs: 200_000,
  maxHoldUs: 100_000,
  maxGapUs: 250_000,
  minKeypointScore: 0.3,
};

/**
 * Timestamp-ordered ring buffer for one camera. Frames may arrive out of order
 * inside the jitter window; anything older than that window, older than the
 * retained window when the ring is full, or already buffered is rejected.
 */
export class PoseFrameRingBuffer {
  private readonly slots: Array<PoseFrame2D | undefined>;
  private head = 0;
  private count = 0;

  private readonly capacity: number;

  public constructor(capacity: number) {
    this.capacity = capacity;
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new Error("Ring buffer capacity must be an integer of at least 2.");
    }
    this.slots = new Array<PoseFrame2D | undefined>(capacity).fill(undefined);
  }

  public size(): number {
    return this.count;
  }

  public at(index: number): PoseFrame2D | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.slots[this.slot(index)];
  }

  public oldestTimestampUs(): number | undefined {
    return this.at(0)?.captureTimestampUs;
  }

  public newestTimestampUs(): number | undefined {
    return this.at(this.count - 1)?.captureTimestampUs;
  }

  public clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
  }

  public insert(frame: PoseFrame2D, jitterWindowUs: number): IngestOutcome {
    const timestamp = frame.captureTimestampUs;
    const newest = this.newestTimestampUs();
    if (newest !== undefined && timestamp < newest - jitterWindowUs) {
      return "late";
    }

    let index = this.count;
    while (index > 0) {
      const candidate = this.at(index - 1);
      if (!candidate) break;
      if (candidate.captureTimestampUs === timestamp) return "duplicate";
      if (candidate.captureTimestampUs < timestamp) break;
      index -= 1;
    }

    if (this.count < this.capacity) {
      for (let position = this.count; position > index; position -= 1) {
        this.slots[this.slot(position)] = this.slots[this.slot(position - 1)];
      }
      this.slots[this.slot(index)] = frame;
      this.count += 1;
      return "accepted";
    }

    if (index === 0) return "late";
    if (index === this.count) {
      this.head = (this.head + 1) % this.capacity;
      this.slots[this.slot(this.count - 1)] = frame;
      return "accepted";
    }
    for (let position = 1; position < index; position += 1) {
      this.slots[this.slot(position - 1)] = this.slots[this.slot(position)];
    }
    this.slots[this.slot(index - 1)] = frame;
    return "accepted";
  }

  /** Resamples this camera at one past instant, or returns undefined. */
  public sampleAt(
    timestampUs: number,
    options: JitterBufferOptions,
  ): SynchronizedCameraSample | undefined {
    const { previous, next } = this.bracket(timestampUs);
    if (previous && next) {
      if (previous === next) {
        return createSample(previous, previous, 0, false, options);
      }
      const gap = next.captureTimestampUs - previous.captureTimestampUs;
      if (gap <= options.maxGapUs) {
        const alpha =
          (timestampUs - previous.captureTimestampUs) / (gap === 0 ? 1 : gap);
        return createSample(previous, next, alpha, true, options);
      }
      const beforeAge = timestampUs - previous.captureTimestampUs;
      const afterAge = next.captureTimestampUs - timestampUs;
      const nearer = beforeAge <= afterAge ? previous : next;
      const age = Math.min(beforeAge, afterAge);
      if (age > options.maxHoldUs) return undefined;
      return createSample(nearer, nearer, 0, true, options);
    }
    if (previous) {
      if (timestampUs - previous.captureTimestampUs > options.maxHoldUs) {
        return undefined;
      }
      return createSample(previous, previous, 0, true, options);
    }
    if (next) {
      if (next.captureTimestampUs - timestampUs > options.maxHoldUs) {
        return undefined;
      }
      return createSample(next, next, 0, true, options);
    }
    return undefined;
  }

  private bracket(timestampUs: number): {
    previous: PoseFrame2D | undefined;
    next: PoseFrame2D | undefined;
  } {
    let low = 0;
    let high = this.count - 1;
    let previousIndex = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = this.at(middle);
      if (!candidate) break;
      if (candidate.captureTimestampUs <= timestampUs) {
        previousIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const previous = previousIndex >= 0 ? this.at(previousIndex) : undefined;
    if (previous?.captureTimestampUs === timestampUs) {
      return { previous, next: previous };
    }
    return { previous, next: this.at(previousIndex + 1) };
  }

  private slot(index: number): number {
    return (this.head + index) % this.capacity;
  }
}

/**
 * Holds one ring buffer per camera and resamples every camera at a shared past
 * instant. Timestamps stay opaque values from the external synchronized time
 * service; no clock offset is estimated here.
 */
export class MultiCameraJitterBuffer {
  private readonly buffers = new Map<string, PoseFrameRingBuffer>();
  private acceptedFrames = 0;
  private droppedFrames = 0;

  private options: JitterBufferOptions;

  public constructor(options: JitterBufferOptions) {
    this.options = options;
  }

  public configure(options: JitterBufferOptions): void {
    this.options = options;
    this.clear();
  }

  public ingest(frame: PoseFrame2D): IngestOutcome {
    let buffer = this.buffers.get(frame.cameraId);
    if (!buffer) {
      buffer = new PoseFrameRingBuffer(this.options.capacityPerCamera);
      this.buffers.set(frame.cameraId, buffer);
    }
    const outcome = buffer.insert(frame, this.options.jitterWindowUs);
    if (outcome === "accepted") this.acceptedFrames += 1;
    else this.droppedFrames += 1;
    return outcome;
  }

  public cameraIds(): string[] {
    return [...this.buffers.keys()].sort();
  }

  public bufferedFrameCount(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.size();
    return total;
  }

  public acceptedFrameCount(): number {
    return this.acceptedFrames;
  }

  public droppedFrameCount(): number {
    return this.droppedFrames;
  }

  /** Newest buffered timestamp across every camera. */
  public newestTimestampUs(): number | undefined {
    let newest: number | undefined;
    for (const buffer of this.buffers.values()) {
      const candidate = buffer.newestTimestampUs();
      if (candidate === undefined) continue;
      if (newest === undefined || candidate > newest) newest = candidate;
    }
    return newest;
  }

  /** Oldest buffered timestamp across every camera. */
  public oldestTimestampUs(): number | undefined {
    let oldest: number | undefined;
    for (const buffer of this.buffers.values()) {
      const candidate = buffer.oldestTimestampUs();
      if (candidate === undefined) continue;
      if (oldest === undefined || candidate < oldest) oldest = candidate;
    }
    return oldest;
  }

  public sampleAt(timestampUs: number): SynchronizedPoseSample {
    const cameras: SynchronizedCameraSample[] = [];
    for (const cameraId of this.cameraIds()) {
      const sample = this.buffers
        .get(cameraId)
        ?.sampleAt(timestampUs, this.options);
      if (sample) cameras.push(sample);
    }
    return { timestampUs, cameras };
  }

  public clear(): void {
    for (const buffer of this.buffers.values()) buffer.clear();
    this.buffers.clear();
    this.acceptedFrames = 0;
    this.droppedFrames = 0;
  }
}

function createSample(
  previous: PoseFrame2D,
  next: PoseFrame2D,
  alpha: number,
  interpolated: boolean,
  options: JitterBufferOptions,
): SynchronizedCameraSample {
  const clamped = Math.min(Math.max(alpha, 0), 1);
  return {
    cameraId: previous.cameraId,
    calibrationId: previous.calibrationId,
    frameWidth: previous.frameWidth,
    frameHeight: previous.frameHeight,
    previousTimestampUs: previous.captureTimestampUs,
    nextTimestampUs: next.captureTimestampUs,
    alpha: clamped,
    interpolated,
    persons: mergePersons(previous, next, clamped, interpolated, options),
  };
}

function mergePersons(
  previous: PoseFrame2D,
  next: PoseFrame2D,
  alpha: number,
  interpolated: boolean,
  options: JitterBufferOptions,
): SynchronizedPerson2D[] {
  const previousPersons = new Map(
    previous.persons.map((person) => [person.trackingId, person]),
  );
  const nextPersons =
    previous === next
      ? previousPersons
      : new Map(next.persons.map((person) => [person.trackingId, person]));
  const trackingIds = [
    ...new Set([...previousPersons.keys(), ...nextPersons.keys()]),
  ];
  const persons: SynchronizedPerson2D[] = [];
  for (const trackingId of trackingIds) {
    const before = previousPersons.get(trackingId);
    const after = nextPersons.get(trackingId);
    if (before && after && before !== after) {
      persons.push({
        trackingId,
        score: lerp(before.score, after.score, alpha),
        keypoints: mergeKeypoints(before, after, alpha, options),
      });
      continue;
    }
    const single = before ?? after;
    if (!single) continue;
    persons.push({
      trackingId,
      score: single.score,
      keypoints: singleKeypoints(single, interpolated),
    });
  }
  return persons;
}

function mergeKeypoints(
  before: PoseFrame2DPerson,
  after: PoseFrame2DPerson,
  alpha: number,
  options: JitterBufferOptions,
): SynchronizedKeypoint2D[] {
  const beforeById = keypointsById(before);
  const afterById = keypointsById(after);
  return COCO_17_KEYPOINT_IDS.map((id) => {
    const start = beforeById.get(id);
    const end = afterById.get(id);
    const startValid = isVisible(start, options.minKeypointScore);
    const endValid = isVisible(end, options.minKeypointScore);
    if (start && end && startValid && endValid) {
      return {
        id,
        x: lerp(start.x, end.x, alpha),
        y: lerp(start.y, end.y, alpha),
        score: lerp(start.score, end.score, alpha),
        filled: true,
      };
    }
    // Occlusion fill: keep the one visible observation instead of blending a
    // low-confidence estimate into it.
    if (start && startValid) {
      return { id, x: start.x, y: start.y, score: start.score, filled: true };
    }
    if (end && endValid) {
      return { id, x: end.x, y: end.y, score: end.score, filled: true };
    }
    if (start && end) {
      return {
        id,
        x: lerp(start.x, end.x, alpha),
        y: lerp(start.y, end.y, alpha),
        score: lerp(start.score, end.score, alpha),
        filled: true,
      };
    }
    const single = start ?? end;
    return {
      id,
      x: single?.x ?? 0,
      y: single?.y ?? 0,
      score: single?.score ?? 0,
      filled: true,
    };
  });
}

function singleKeypoints(
  person: PoseFrame2DPerson,
  interpolated: boolean,
): SynchronizedKeypoint2D[] {
  const byId = keypointsById(person);
  return COCO_17_KEYPOINT_IDS.map((id) => {
    const keypoint = byId.get(id);
    return {
      id,
      x: keypoint?.x ?? 0,
      y: keypoint?.y ?? 0,
      score: keypoint?.score ?? 0,
      filled: interpolated || !keypoint,
    };
  });
}



function keypointsById(
  person: PoseFrame2DPerson,
): Map<Coco17KeypointId, Keypoint2D> {
  return new Map(person.keypoints.map((keypoint) => [keypoint.id, keypoint]));
}

function isVisible(
  keypoint: Keypoint2D | undefined,
  minimumScore: number,
): boolean {
  return keypoint !== undefined && keypoint.score >= minimumScore;
}

function lerp(start: number, end: number, alpha: number): number {
  return start + (end - start) * alpha;
}
