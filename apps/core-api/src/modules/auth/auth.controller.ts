import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
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

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ type: Number, minimum: 60 })
  expiresInSeconds!: number;

  @ApiProperty({ type: PublicUserResponse })
  user!: PublicUserResponse;
}

const LoginBodySchema = z.object({
  username: z.string().max(80),
  password: z.string().max(128),
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
