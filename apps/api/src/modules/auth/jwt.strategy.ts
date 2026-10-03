import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { AuthService, type JwtPayload } from './auth.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly auth: AuthService) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('缺少 JWT_SECRET：JwtStrategy 建不起来。请从 .env.example 复制出 .env。');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * 返回的对象会被挂到 request.user 上，供 @CurrentUser() 和 RolesGuard 使用。
   * 这里必须回库校验，不能直接信 token 里的内容。
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const identity = await this.auth.findIdentity(payload.sub);
    if (!identity || !identity.isActive) {
      throw new UnauthorizedException('账号不存在或已停用');
    }

    return {
      id: identity.id,
      username: identity.username,
      displayName: identity.displayName,
      role: identity.role,
    };
  }
}
