import bcrypt from 'bcrypt';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const BCRYPT_COST = 12;

export type CreateTeacherInput = {
  username: string;
  password: string;
  name: string;
};

export type TeacherSummary = {
  id: string;
  userId: string;
  username: string;
  name: string;
  isActive: boolean;
};

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toSummary(teacher: {
  id: string;
  name: string;
  isActive: boolean;
  user: { id: string; username: string };
}): TeacherSummary {
  return {
    id: teacher.id,
    userId: teacher.user.id,
    username: teacher.user.username,
    name: teacher.name,
    isActive: teacher.isActive,
  };
}

@Injectable()
export class TeachersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateTeacherInput): Promise<TeacherSummary> {
    const username = input.username.trim();
    const name = input.name.trim();
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    try {
      const teacher = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username,
            passwordHash,
            role: UserRole.TEACHER,
          },
          select: { id: true },
        });
        return tx.teacher.create({
          data: { userId: user.id, name },
          select: {
            id: true,
            name: true,
            isActive: true,
            user: { select: { id: true, username: true } },
          },
        });
      });
      return toSummary(teacher);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ConflictException('用户名已存在');
      throw error;
    }
  }

  async list(): Promise<TeacherSummary[]> {
    const teachers = await this.prisma.teacher.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        isActive: true,
        user: { select: { id: true, username: true } },
      },
    });
    return teachers.map(toSummary);
  }
}
