import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        // getOrThrow：JWT_SECRET 缺失时必须起不来，不能退化成 undefined 去签 token
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // 这里的断言只是因为 jsonwebtoken 的 expiresIn 用的是 ms 的模板字面量类型，
          // 从配置读只能拿到 string。格式已在 config/env.validation.ts 里校验过，不会传进脏值。
          expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '12h',
        } as JwtModuleOptions['signOptions'],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
