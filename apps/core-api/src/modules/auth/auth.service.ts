import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { type UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { parseAuthConfig, type AuthConfig } from './auth-config.js';
import {
  PUBLIC_USER_SELECT,
  USER_AUTH_SELECT,
  type AuthenticatedActor,
  type PublicUser,
} from './auth.types.js';

const JWT_ISSUER = 'piano-core';
const JWT_AUDIENCE = 'piano-web';
const LOGIN_ERROR_MESSAGE = '用户名或密码不正确';
const SESSION_EXPIRED_MESSAGE = '登录状态无效或已过期';
const REFRESH_TOKEN_BYTES = 32;

type LoginInput = {
  username: string;
  password: string;
};

export type LoginResult = {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  refreshExpiresInSeconds: number;
  user: PublicUser;
};

function loginError(): UnauthorizedException {
  return new UnauthorizedException(LOGIN_ERROR_MESSAGE);
}

function sessionExpired(): UnauthorizedException {
  return new UnauthorizedException(SESSION_EXPIRED_MESSAGE);
}

function toPublicUser(user: {
  id: string;
  username: string;
  role: UserRole;
  teacher: { id: string; isActive: boolean } | null;
}): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    ...(user.teacher?.isActive ? { teacherId: user.teacher.id } : {}),
  };
}

function tokenSubject(payload: string | JwtPayload): string | undefined {
  return typeof payload === 'string' ? undefined : typeof payload.sub === 'string' ? payload.sub : undefined;
}

/** Refresh tokens are bearer credentials: only their SHA-256 digest is persisted. */
function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function createRefreshTokenValue(): string {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const config = parseAuthConfig(process.env);
    const username = input.username.trim();
    if (!username || !input.password) throw loginError();

    const user = await this.prisma.user.findUnique({
      where: { username },
      select: USER_AUTH_SELECT,
    });
    if (!user || !user.isActive || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw loginError();
    }

    await this.pruneExpiredRefreshTokens(user.id);
    const refreshToken = await this.issueRefreshToken(user.id, config);
    return this.buildSession(user, refreshToken.raw, config);
  }

  /**
   * Rotates the refresh token: the presented token is revoked in the same
   * transaction that persists its replacement, so a replayed token can never
   * produce two usable sessions.
   */
  async refresh(rawToken: string): Promise<LoginResult> {
    const config = parseAuthConfig(process.env);
    const token = rawToken.trim();
    if (!token) throw sessionExpired();

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: USER_AUTH_SELECT },
      },
    });
    if (!record || record.revokedAt || record.expiresAt.getTime() <= Date.now() || !record.user.isActive) {
      throw sessionExpired();
    }

    const nextRaw = await this.prisma.$transaction(async (tx) => {
      const raw = createRefreshTokenValue();
      const created = await tx.refreshToken.create({
        data: {
          userId: record.userId,
          tokenHash: hashRefreshToken(raw),
          expiresAt: new Date(Date.now() + config.JWT_REFRESH_TOKEN_TTL_SECONDS * 1000),
        },
        select: { id: true },
      });
      const revoked = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedByTokenId: created.id },
      });
      if (revoked.count !== 1) throw sessionExpired();
      return raw;
    });

    return this.buildSession(record.user, nextRaw, config);
  }

  /** Idempotent: revoking an unknown or already revoked token is not an error. */
  async logout(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!token) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async resolveActor(accessToken: string): Promise<AuthenticatedActor> {
    const config = parseAuthConfig(process.env);
    let subject: string | undefined;
    try {
      subject = tokenSubject(
        jwt.verify(accessToken, config.JWT_SIGNING_SECRET, {
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      );
    } catch {
      throw sessionExpired();
    }
    if (!subject) throw sessionExpired();

    const user = await this.prisma.user.findUnique({
      where: { id: subject },
      select: PUBLIC_USER_SELECT,
    });
    if (!user?.isActive) throw sessionExpired();
    return toPublicUser(user);
  }

  private buildSession(
    user: { id: string; username: string; role: UserRole; teacher: { id: string; isActive: boolean } | null },
    refreshToken: string,
    config: AuthConfig,
  ): LoginResult {
    return {
      accessToken: jwt.sign({}, config.JWT_SIGNING_SECRET, {
        subject: user.id,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: config.JWT_ACCESS_TOKEN_TTL_SECONDS,
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresInSeconds: config.JWT_ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresInSeconds: config.JWT_REFRESH_TOKEN_TTL_SECONDS,
      user: toPublicUser(user),
    };
  }

  private async issueRefreshToken(userId: string, config: AuthConfig): Promise<{ id: string; raw: string }> {
    const raw = createRefreshTokenValue();
    const record = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(raw),
        expiresAt: new Date(Date.now() + config.JWT_REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
      select: { id: true },
    });
    return { id: record.id, raw };
  }

  private async pruneExpiredRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    });
  }
}
