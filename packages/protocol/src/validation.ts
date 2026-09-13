import {Value} from '@sinclair/typebox/value';
import type {Static, TSchema} from '@sinclair/typebox';

export interface ProtocolValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ProtocolValidationFailure {
  ok: false;
  errors: Array<{path: string; message: string}>;
}

export function validateProtocol<T extends TSchema>(
  schema: T,
  value: unknown
): ProtocolValidationSuccess<Static<T>> | ProtocolValidationFailure {
  if (Value.Check(schema, value)) return {ok: true, value: value as Static<T>};
  return {
    ok: false,
    errors: [...Value.Errors(schema, value)].map(({path, message}) => ({path, message}))
  };
}
