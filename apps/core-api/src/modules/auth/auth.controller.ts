import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiNoContentResponse, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { UserRole } from '../../generated/prisma/client.js';
import { AuthService, type LoginResult } from './auth.service.js';
import { JwtAuthGuard, type AuthenticatedRequest } from './jwt-auth.guard.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import type { PublicUser } from './auth.types.js';

class LoginBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  username!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 128, format: 'password' })
  password!: string;
}

class RefreshTokenBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  refreshToken!: string;
}

class PublicUserResponse implements PublicUser {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  username!: string;

  @ApiProperty({ enum: UserRole })
  role!: UserRole;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  teacherId?: string;
}

class LoginResponse implements LoginResult {
  @ApiProperty({ type: String })
  accessToken!: string;

  @ApiProperty({ type: String })
  refreshToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ type: Number, minimum: 60 })
  expiresInSeconds!: number;

  @ApiProperty({ type: Number, minimum: 600 })
  refreshExpiresInSeconds!: number;

  @ApiProperty({ type: PublicUserResponse })
  user!: PublicUserResponse;
}

const LoginBodySchema = z.object({
  username: z.string().max(80),
  password: z.string().max(128),
}).strict();

const RefreshTokenBodySchema = z.object({
  refreshToken: z.string().min(1).max(200),
}).strict();

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @ApiBody({ type: LoginBody })
  @ApiOkResponse({ type: LoginResponse })
  login(@Body() body: unknown): Promise<LoginResult> {
    const parsed = LoginBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.auth.login(parsed.data);
  }

  @Post('refresh')
  @ApiBody({ type: RefreshTokenBody })
  @ApiOkResponse({ type: LoginResponse })
  refresh(@Body() body: unknown): Promise<LoginResult> {
    const parsed = RefreshTokenBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.auth.refresh(parsed.data.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBody({ type: RefreshTokenBody })
  @ApiNoContentResponse()
  logout(@Body() body: unknown): Promise<void> {
    const parsed = RefreshTokenBodySchema.safeParse(body);
    if (!parsed.success) return Promise.resolve();
    return this.auth.logout(parsed.data.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: PublicUserResponse })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  me(@Req() request: AuthenticatedRequest): PublicUser {
    if (!request.actor) throw new BadRequestException('登录状态无效或已过期');
    return request.actor;
  }
}
