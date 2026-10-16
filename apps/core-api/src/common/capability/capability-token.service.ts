import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

const CapabilityPayloadSchema = z.object({
  iss: z.literal('piano-core'),
  aud: z.literal('piano-core-internal'),
  sub: z.string().min(1),
  threadId: z.string().uuid(),
  runId: z.string().uuid(),
  jti: z.string().uuid(),
  permissions: z.array(z.enum(['READ', 'PREVIEW_L1', 'PREVIEW_L2'])).min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type CapabilityPayload = z.infer<typeof CapabilityPayloadSchema>;

type CapabilityKeyConfig = {
  privateKey: KeyObject;
  publicKey: KeyObject;
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

@Injectable()
export class CapabilityTokenService {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;

  constructor(keys?: CapabilityKeyConfig) {
    if (keys) {
      this.#privateKey = keys.privateKey;
      this.#publicKey = keys.publicKey;
      return;
    }

    const encoded = process.env['CAPABILITY_SIGNING_PRIVATE_KEY_B64'];
    if (!encoded) {
      throw new Error('CAPABILITY_SIGNING_PRIVATE_KEY_B64 未配置');
    }
    this.#privateKey = createPrivateKey(Buffer.from(encoded, 'base64').toString('utf8'));
    this.#publicKey = createPublicKey(this.#privateKey);
  }

  issue(input: {
    userId: string;
    threadId: string;
    runId: string;
    permissions: CapabilityPayload['permissions'];
    ttlSeconds?: number;
    now?: Date;
  }): string {
    const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const payload: CapabilityPayload = {
      iss: 'piano-core',
      aud: 'piano-core-internal',
      sub: input.userId,
      threadId: input.threadId,
      runId: input.runId,
      jti: randomUUID(),
      permissions: input.permissions,
      iat: issuedAt,
      exp: issuedAt + (input.ttlSeconds ?? 300),
    };
    const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(payload)}`;
    const signature = sign(null, Buffer.from(signingInput), this.#privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  verify(token: string, now: Date = new Date()): CapabilityPayload {
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Capability 无效');
    const [headerPart, payloadPart, signaturePart] = parts;
    if (!headerPart || !payloadPart || !signaturePart) {
      throw new UnauthorizedException('Capability 无效');
    }

    const signingInput = `${headerPart}.${payloadPart}`;
    const validSignature = verify(
      null,
      Buffer.from(signingInput),
      this.#publicKey,
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!validSignature) throw new UnauthorizedException('Capability 无效');

    try {
      const header = z
        .object({ alg: z.literal('EdDSA'), typ: z.literal('JWT') })
        .parse(JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')));
      void header;
      const payload = CapabilityPayloadSchema.parse(
        JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')),
      );
      if (payload.exp <= Math.floor(now.getTime() / 1000)) {
        throw new UnauthorizedException('Capability 已过期');
      }
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Capability 无效');
    }
  }
}
