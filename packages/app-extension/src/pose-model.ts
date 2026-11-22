/**
 * Hands the MoveNet model the build chose to the pose pipeline.
 *
 * The contract extension reads `__TWMP_POSE_MODEL__` when it loads the model, so the shell sets it
 * while it loads, before any script can start the pipeline. What to set is decided at build time
 * (`TWRMC_POSE_MODEL`, see pose-model-plugin.ts); this only turns that into the value the extension
 * takes.
 */

export type PoseModelSpec =
  | { readonly mode: 'hub' }
  | { readonly mode: 'local'; readonly url: string }
  | {
      readonly mode: 'embedded';
      readonly modelJson: unknown;
      /** The weight shards in manifest order, base64. */
      readonly weights: readonly string[];
    };

export const poseModelGlobalKey = '__TWMP_POSE_MODEL__';

/**
 * The value for `__TWMP_POSE_MODEL__`, or undefined to leave TF Hub in charge.
 *
 * The venue host answers only requests that carry the token the page was opened with, so a served
 * model's URL takes it along. TensorFlow.js keeps the query when it asks for the weight shards next
 * to `model.json`, so the shards carry it too.
 */
export function poseModelGlobalValue(
  spec: PoseModelSpec,
  search: string,
): unknown {
  if (spec.mode === 'hub') return undefined;
  if (spec.mode === 'local') {
    const token = new URLSearchParams(search).get('token');
    return {
      url:
        token === null
          ? spec.url
          : `${spec.url}?token=${encodeURIComponent(token)}`,
    };
  }
  return {
    modelJson: spec.modelJson,
    weights: spec.weights.map(decodeBase64),
  };
}

export function installPoseModel(
  spec: PoseModelSpec,
  target: Record<string, unknown> = globalThis as unknown as Record<
    string,
    unknown
  >,
  search: string = globalThis.location?.search ?? '',
): void {
  const value = poseModelGlobalValue(spec, search);
  if (value !== undefined) target[poseModelGlobalKey] = value;
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
