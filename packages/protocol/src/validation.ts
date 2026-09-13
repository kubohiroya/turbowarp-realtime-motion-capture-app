import {Value} from '@sinclair/typebox/value';
import type {Static, TSchema} from '@sinclair/typebox';

import {SessionPolicySchema, type SessionPolicy} from './schemas.js';

export interface ProtocolValidationSuccess<T> {
  ok: true;
  value: T;
}

export function validateSessionPolicy(
  value: unknown,
  nowMilliseconds = Date.now()
): ProtocolValidationSuccess<SessionPolicy> | ProtocolValidationFailure {
  const validated = validateProtocol(SessionPolicySchema, value);
  if (!validated.ok) return validated;
  const issuedAt = Date.parse(validated.value.issuedAt);
  const expiresAt = Date.parse(validated.value.expiresAt);
  if (expiresAt <= issuedAt) {
    return {ok: false, errors: [{path: '/expiresAt', message: 'must be later than issuedAt'}]};
  }
  if (expiresAt <= nowMilliseconds) {
    return {ok: false, errors: [{path: '/expiresAt', message: 'session policy has expired'}]};
  }
  return validated;
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
