/**
 * Builds the `blocks` object of an expanded SB3 target.
 *
 * Scratch stores a script as a flat map of blocks linked by id, which is unreadable to write by hand
 * and impossible to review as a diff. These helpers keep the script readable in source and emit the
 * flat form, with ids derived from position rather than generated at random so the same source keeps
 * producing the same archive.
 */
export type BlockId = string;

export interface SerializedBlock {
  opcode: string;
  next: BlockId | null;
  parent: BlockId | null;
  inputs: Record<string, unknown[]>;
  fields: Record<string, unknown[]>;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
}

export type SerializedBlocks = Record<BlockId, SerializedBlock>;

/** Scratch's input type tags, named so the encoding is legible where it is used. */
const inputKind = {
  shadowOnly: 1,
  blockOnly: 2,
  blockWithShadow: 3,
} as const;

const primitive = {
  number: 4,
  text: 10,
  broadcast: 11,
  variable: 12,
  list: 13,
} as const;

/** Allocates child blocks and C-block bodies under the block that owns the input. */
export interface Allocator {
  block(node: BlockNode): BlockId;
  stack(nodes: readonly BlockNode[]): BlockId;
}

export interface InputValue {
  readonly encode: (allocate: Allocator) => unknown[];
}

export interface NamedReference {
  readonly name: string;
  readonly id: string;
}

export interface FieldReference {
  readonly value: string;
  readonly id: string;
}

const assertNamedReference = (reference: NamedReference): void => {
  if (reference.name.length === 0 || reference.id.length === 0) {
    throw new TypeError(
      'A named Scratch reference needs both a name and a stable id.',
    );
  }
};

export function namedReference(name: string, id: string): NamedReference {
  const reference = { name, id };
  assertNamedReference(reference);
  return reference;
}

export interface BlockNode {
  readonly opcode: string;
  readonly inputs?: Readonly<Record<string, InputValue>>;
  readonly fields?: Readonly<Record<string, string | FieldReference>>;
}

export interface Script {
  readonly x: number;
  readonly y: number;
  readonly blocks: readonly BlockNode[];
}

/** A literal typed into a text slot. */
export function text(value: string): InputValue {
  return { encode: () => [inputKind.shadowOnly, [primitive.text, value]] };
}

/** A literal typed into a number slot. */
export function number(value: number): InputValue {
  return {
    encode: () => [inputKind.shadowOnly, [primitive.number, String(value)]],
  };
}

/** A stable Scratch variable reference embedded directly in a reporter input. */
export function variable(reference: NamedReference): InputValue {
  assertNamedReference(reference);
  return {
    encode: () => [
      inputKind.blockWithShadow,
      [primitive.variable, reference.name, reference.id],
      [primitive.text, ''],
    ],
  };
}

/** A stable Scratch list reference embedded directly in a reporter input. */
export function list(reference: NamedReference): InputValue {
  assertNamedReference(reference);
  return {
    encode: () => [
      inputKind.blockWithShadow,
      [primitive.list, reference.name, reference.id],
      [primitive.text, ''],
    ],
  };
}

/** A broadcast-menu input. The explicit id keeps senders and receiver hats connected. */
export function broadcast(reference: NamedReference): InputValue {
  assertNamedReference(reference);
  return {
    encode: () => [
      inputKind.shadowOnly,
      [primitive.broadcast, reference.name, reference.id],
    ],
  };
}

/** A dropdown field that names a variable, list, broadcast, or other stable Scratch entity. */
export function field(reference: NamedReference): FieldReference {
  assertNamedReference(reference);
  return { value: reference.name, id: reference.id };
}

/**
 * A reporter placed in a round slot.
 *
 * The slot keeps an empty text shadow underneath, which is what Scratch writes when a reporter is
 * dropped onto a slot that had a literal, so removing the reporter in the editor leaves a usable
 * slot rather than a hole.
 */
export function reporter(node: BlockNode): InputValue {
  return {
    encode: (allocate) => [
      inputKind.blockWithShadow,
      allocate.block(node),
      [primitive.text, ''],
    ],
  };
}

/** A boolean block placed in a hexagonal slot. Boolean slots have no shadow. */
export function condition(node: BlockNode): InputValue {
  return { encode: (allocate) => [inputKind.blockOnly, allocate.block(node)] };
}

/** A non-empty body placed inside a C block. */
export function substack(nodes: readonly BlockNode[]): InputValue {
  if (nodes.length === 0)
    throw new TypeError('A substack needs at least one block.');
  return { encode: (allocate) => [inputKind.blockOnly, allocate.stack(nodes)] };
}

export function block(
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
  fields: Readonly<Record<string, string | FieldReference>> = {},
): BlockNode {
  return { opcode, inputs, fields };
}

export function script(
  position: { x: number; y: number },
  blocks: readonly BlockNode[],
): Script {
  if (blocks.length === 0)
    throw new TypeError('A script needs at least one block.');
  return { x: position.x, y: position.y, blocks };
}

/**
 * Flattens scripts into the serialized form.
 *
 * Ids are `s<script>b<block>` so a reviewer can find a block in the diff by where it sits,
 * and so an unrelated edit does not renumber every other script.
 */
export function buildBlocks(scripts: readonly Script[]): SerializedBlocks {
  const serialized: SerializedBlocks = {};

  scripts.forEach((current, scriptIndex) => {
    let counter = 0;
    const nextId = () => `s${scriptIndex + 1}b${(counter += 1)}`;

    const emit = (
      node: BlockNode,
      id: BlockId,
      parent: BlockId | null,
      top: boolean,
    ): void => {
      const entry: SerializedBlock = {
        opcode: node.opcode,
        next: null,
        parent,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: top,
      };
      if (top) {
        entry.x = current.x;
        entry.y = current.y;
      }
      serialized[id] = entry;

      const allocate: Allocator = {
        block: (child) => {
          const childId = nextId();
          emit(child, childId, id, false);
          return childId;
        },
        stack: (body) => emitChain(body, id),
      };

      for (const [name, value] of Object.entries(node.inputs ?? {})) {
        entry.inputs[name] = value.encode(allocate);
      }
      for (const [name, value] of Object.entries(node.fields ?? {})) {
        entry.fields[name] =
          typeof value === 'string' ? [value, null] : [value.value, value.id];
      }
    };

    const emitChain = (
      nodes: readonly BlockNode[],
      parent: BlockId | null,
    ): BlockId => {
      const ids = nodes.map(() => nextId());
      nodes.forEach((node, index) => {
        const id = ids[index] as BlockId;
        emit(
          node,
          id,
          index === 0 ? parent : (ids[index - 1] as BlockId),
          false,
        );
        const next = ids[index + 1];
        if (next !== undefined) (serialized[id] as SerializedBlock).next = next;
      });
      return ids[0] as BlockId;
    };

    const ids = current.blocks.map(() => nextId());
    current.blocks.forEach((node, index) => {
      const id = ids[index] as BlockId;
      emit(
        node,
        id,
        index === 0 ? null : (ids[index - 1] as BlockId),
        index === 0,
      );
      const next = ids[index + 1];
      if (next !== undefined) (serialized[id] as SerializedBlock).next = next;
    });
  });

  return serialized;
}
