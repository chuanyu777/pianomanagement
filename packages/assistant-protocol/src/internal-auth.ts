import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ASSISTANT_CAPABILITY_HEADER,
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from './index.js';

const SIGNED_SECURITY_HEADERS = new Set([
  'authorization',
  ASSISTANT_CAPABILITY_HEADER,
  'last-event-id',
]);

export type InternalSecurityHeaders = Record<string, string | undefined>;

export type InternalRequestSignatureInput = {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body?: string;
  securityHeaders?: InternalSecurityHeaders | undefined;
};

export type SignedInternalRequestInput = {
  secret: string;
  method: string;
  path: string;
  body?: unknown;
  now?: Date;
  nonce?: string;
  securityHeaders?: InternalSecurityHeaders | undefined;
};

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeJson(child)]),
    );
  }
  return value;
}

export function canonicalizeInternalRequestBody(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(normalizeJson(value));
}

export function canonicalizeInternalSecurityHeaders(
  headers: InternalSecurityHeaders = {},
): string {
  const normalized = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (!SIGNED_SECURITY_HEADERS.has(name)) {
      throw new TypeError(`Unsupported signed security header: ${name}`);
    }
    if (/\r|\n/.test(rawValue)) throw new TypeError('Invalid signed security header value');
    const value = rawValue.trim();
    const prior = normalized.get(name);
    if (prior !== undefined && prior !== value) {
      throw new TypeError(`Conflicting values for signed security header: ${name}`);
    }
    normalized.set(name, value);
  }
  return JSON.stringify(
    [...normalized.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function signingInput(input: InternalRequestSignatureInput): string {
  const bodyDigest = createHash('sha256').update(input.body ?? '').digest('base64url');
  return [
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    bodyDigest,
    canonicalizeInternalSecurityHeaders(input.securityHeaders),
  ].join('\n');
}

export function createInternalRequestSignature(input: InternalRequestSignatureInput): string {
  return createHmac('sha256', input.secret).update(signingInput(input)).digest('base64url');
}

export function verifyInternalRequestSignature(
  input: InternalRequestSignatureInput & { signature: string },
): boolean {
  const expected = Buffer.from(createInternalRequestSignature(input));
  const actual = Buffer.from(input.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createSignedInternalRequestHeaders(
  input: SignedInternalRequestInput,
): Record<string, string> {
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1_000).toString();
  const nonce = input.nonce ?? randomUUID();
  const signature = createInternalRequestSignature({
    secret: input.secret,
    timestamp,
    nonce,
    method: input.method,
    path: input.path,
    body: canonicalizeInternalRequestBody(input.body),
    securityHeaders: input.securityHeaders,
  });
  return {
    [INTERNAL_REQUEST_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_REQUEST_NONCE_HEADER]: nonce,
    [INTERNAL_REQUEST_SIGNATURE_HEADER]: signature,
  };
}

export function verifySignedInternalRequest(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  path: string;
  body?: unknown;
  securityHeaders?: InternalSecurityHeaders | undefined;
  now?: Date;
  maxClockSkewSeconds?: number;
}): boolean {
  if (
    !/^[1-9]\d*$/.test(input.timestamp) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.nonce,
    )
  ) {
    return false;
  }
  const requestTime = Number(input.timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (
    !Number.isSafeInteger(requestTime) ||
    Math.abs(now - requestTime) > (input.maxClockSkewSeconds ?? 300)
  ) {
    return false;
  }
  return verifyInternalRequestSignature({
    secret: input.secret,
    timestamp: input.timestamp,
    nonce: input.nonce,
    signature: input.signature,
    method: input.method,
    path: input.path,
    body: canonicalizeInternalRequestBody(input.body),
    securityHeaders: input.securityHeaders,
  });
}

export class InternalRequestReplayProtector {
  readonly #seen = new Map<string, number>();

  consume(nonce: string, now: Date = new Date(), retentionSeconds = 600): boolean {
    const nowMs = now.getTime();
    for (const [seenNonce, expiresAt] of this.#seen) {
      if (expiresAt <= nowMs) this.#seen.delete(seenNonce);
    }
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, nowMs + retentionSeconds * 1_000);
    return true;
  }
}
