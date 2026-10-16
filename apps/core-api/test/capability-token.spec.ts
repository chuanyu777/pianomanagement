import { generateKeyPairSync } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CapabilityTokenService } from '../src/common/capability/capability-token.service.js';

function createService(): CapabilityTokenService {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return new CapabilityTokenService({ privateKey, publicKey });
}

describe('CapabilityTokenService', () => {
  it('issues a five-minute, least-privilege token', () => {
    const service = createService();
    const now = new Date('2026-10-15T00:00:00.000Z');
    const token = service.issue({
      userId: 'owner-1',
      threadId: 'c33c4244-2c78-4b25-b6d3-b62daf712dc5',
      runId: '49463786-f98c-4aa7-a2d0-b686f7066e6f',
      permissions: ['READ'],
      now,
    });
    const payload = service.verify(token, new Date('2026-10-15T00:04:59.000Z'));
    expect(payload.permissions).toEqual(['READ']);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.exp - payload.iat).toBe(300);
  });

  it('rejects expired and tampered tokens', () => {
    const service = createService();
    const now = new Date('2026-10-15T00:00:00.000Z');
    const token = service.issue({
      userId: 'owner-1',
      threadId: 'c33c4244-2c78-4b25-b6d3-b62daf712dc5',
      runId: '49463786-f98c-4aa7-a2d0-b686f7066e6f',
      permissions: ['PREVIEW_L1'],
      now,
    });
    expect(() => service.verify(token, new Date('2026-10-15T00:05:00.000Z'))).toThrow(
      UnauthorizedException,
    );
    const tokenParts = token.split('.');
    const signature = tokenParts[2]!;
    tokenParts[2] = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    expect(() => service.verify(tokenParts.join('.'), now)).toThrow(UnauthorizedException);
  });
});
