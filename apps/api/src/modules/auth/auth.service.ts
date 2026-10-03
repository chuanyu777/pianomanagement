import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { verifyPassword } from '../../common/password.js';
import { UserRole } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';

export type JwtPayload = {
  sub: string;
};

export type LoginResult = {
  accessToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: UserRole;
  };
};

/** 校验通过后交给 JwtStrategy 的身份信息（含数据库当前状态，不是 token 里的旧值）。 */
export type AuthenticatedIdentity = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 登录。
   *
   * 「用户不存在」「密码错」「账号已停用」对外一律返回同一句话、同一个状态码 ——
   * 区分开来等于把「哪些用户名真实存在」免费送给攻击者。
   * 具体的失败原因写在日志里，不写在响应里。
   */
  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        isActive: true,
        passwordHash: true,
      },
    });

    const passwordOk = user ? await verifyPassword(dto.password, user.passwordHash) : false;
    if (!user || !user.isActive || !passwordOk) {
      throw new UnauthorizedException('用户名或密码不正确');
    }

    const payload: JwtPayload = { sub: user.id };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    };
  }

  /**
   * 每次带 token 的请求都回库取一次当前身份。
   *
   * 为什么不把 role 塞进 token：那样改了角色/停用了账号，也要等 token 过期才生效。
   * 权限变更立即生效比省这一次查询重要得多。
   */
  findIdentity(userId: string): Promise<AuthenticatedIdentity | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        isActive: true,
      },
    });
  }
}
