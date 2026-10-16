import bcrypt from 'bcrypt';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { PublicUser } from './auth.types.js';

const BCRYPT_COST = 12;

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class OwnerBootstrapService {
  constructor(private readonly prisma: PrismaService) {}

  async createOwner(input: { username: string; password: string }): Promise<PublicUser> {
    const username = input.username.trim();
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    try {
      return await this.prisma.user.create({
        data: { username, passwordHash, role: UserRole.OWNER },
        select: { id: true, username: true, role: true },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ConflictException('用户名已存在');
      throw error;
    }
  }
}
