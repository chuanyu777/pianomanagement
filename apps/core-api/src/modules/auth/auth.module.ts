import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { OwnerBootstrapService } from './owner-bootstrap.service.js';
import { RolesGuard } from './roles.guard.js';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard, OwnerBootstrapService],
  exports: [AuthService, JwtAuthGuard, RolesGuard, OwnerBootstrapService],
})
export class AuthModule {}
