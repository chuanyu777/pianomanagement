import bcrypt from 'bcrypt';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { type UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { parseAuthConfig } from './auth-config.js';
import {
  PUBLIC_USER_SELECT,
  USER_AUTH_SELECT,
  type AuthenticatedActor,
  type PublicUser,
} from './auth.types.js';

const JWT_ISSUER = 'piano-core';
const JWT_AUDIENCE = 'piano-web';
const LOGIN_ERROR_MESSAGE = '用户名或密码不正确';

type LoginInput = {
  username: string;
  password: string;
};

export type LoginResult = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  user: PublicUser;
};

function loginError(): UnauthorizedException {
  return new UnauthorizedException(LOGIN_ERROR_MESSAGE);
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

    const publicUser = toPublicUser(user);
    return {
      accessToken: jwt.sign({}, config.JWT_SIGNING_SECRET, {
        subject: user.id,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: config.JWT_ACCESS_TOKEN_TTL_SECONDS,
      }),
      tokenType: 'Bearer',
      expiresInSeconds: config.JWT_ACCESS_TOKEN_TTL_SECONDS,
      user: publicUser,
    };
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
      throw new UnauthorizedException('登录状态无效或已过期');
    }
    if (!subject) throw new UnauthorizedException('登录状态无效或已过期');

    const user = await this.prisma.user.findUnique({
      where: { id: subject },
      select: PUBLIC_USER_SELECT,
    });
    if (!user?.isActive) throw new UnauthorizedException('登录状态无效或已过期');
    return toPublicUser(user);
  }
}
