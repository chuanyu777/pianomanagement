import bcrypt from 'bcrypt';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const BCRYPT_COST = 12;

export type CreateTeacherProfileInput = {
  name: string;
  defaultBaseSalary: Prisma.Decimal;
  defaultCommissionRate: Prisma.Decimal;
};

export type CreateTeacherInput = {
  username?: string;
  password?: string;
  name: string;
  defaultBaseSalary?: Prisma.Decimal;
  defaultCommissionRate?: Prisma.Decimal;
};

export type OpenTeacherLoginAccountInput = { username: string; password: string };

export type UpdateTeacherCompensationInput = {
  defaultBaseSalary: Prisma.Decimal;
  defaultCommissionRate: Prisma.Decimal;
};

export type TeacherSummary = {
  id: string;
  userId: string | null;
  username: string | null;
  name: string;
  isActive: boolean;
  defaultBaseSalary: string;
  defaultCommissionRate: string;
};

export type TeacherCompensationPreview = {
  teacher: TeacherSummary;
  updatedAt: Date;
  nextBaseSalary: string;
  nextCommissionRate: string;
};

type TeacherTransaction = Pick<Prisma.TransactionClient, 'teacher'>;

const TEACHER_SUMMARY_SELECT = {
  id: true,
  name: true,
  isActive: true,
  defaultBaseSalary: true,
  defaultCommissionRate: true,
  user: { select: { id: true, username: true } },
} as const;

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toSummary(teacher: {
  id: string;
  name: string;
  isActive: boolean;
  defaultBaseSalary: Prisma.Decimal;
  defaultCommissionRate: Prisma.Decimal;
  user: { id: string; username: string } | null;
}): TeacherSummary {
  return {
    id: teacher.id,
    userId: teacher.user?.id ?? null,
    username: teacher.user?.username ?? null,
    name: teacher.name,
    isActive: teacher.isActive,
    defaultBaseSalary: teacher.defaultBaseSalary.toFixed(2),
    defaultCommissionRate: teacher.defaultCommissionRate.toFixed(4),
  };
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 120) throw new ConflictException('老师姓名不合法');
  return normalized;
}

function validateCompensation(input: UpdateTeacherCompensationInput): void {
  if (!input.defaultBaseSalary.isFinite() || input.defaultBaseSalary.lt(0)
    || input.defaultBaseSalary.gte('1000000000000') || input.defaultBaseSalary.decimalPlaces() > 2
    || !input.defaultCommissionRate.isFinite() || input.defaultCommissionRate.lt(0)
    || input.defaultCommissionRate.gte('1000') || input.defaultCommissionRate.decimalPlaces() > 4) {
    throw new ConflictException('工资配置不合法');
  }
}

@Injectable()
export class TeachersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateTeacherInput): Promise<TeacherSummary> {
    const hasUsername = input.username !== undefined;
    const hasPassword = input.password !== undefined;
    if (hasUsername !== hasPassword) throw new ConflictException('用户名和密码必须同时提供');

    if (!hasUsername) {
      return this.createProfile({
        name: input.name,
        defaultBaseSalary: input.defaultBaseSalary ?? new Prisma.Decimal('0.00'),
        defaultCommissionRate: input.defaultCommissionRate ?? new Prisma.Decimal('0.0000'),
      });
    }

    const username = input.username!.trim();
    const name = validateName(input.name);
    if (!username || username.length > 80 || input.password!.length < 12 || input.password!.length > 128) {
      throw new ConflictException('登录账号信息不合法');
    }
    const compensation = {
      defaultBaseSalary: input.defaultBaseSalary ?? new Prisma.Decimal('0.00'),
      defaultCommissionRate: input.defaultCommissionRate ?? new Prisma.Decimal('0.0000'),
    };
    validateCompensation(compensation);
    const passwordHash = await bcrypt.hash(input.password!, BCRYPT_COST);
    try {
      const teacher = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { username, passwordHash, role: UserRole.TEACHER },
          select: { id: true },
        });
        return tx.teacher.create({
          data: { userId: user.id, name, ...compensation },
          select: TEACHER_SUMMARY_SELECT,
        });
      });
      return toSummary(teacher);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ConflictException('用户名已存在');
      throw error;
    }
  }

  async openLoginAccount(id: string, input: OpenTeacherLoginAccountInput): Promise<TeacherSummary> {
    const username = input.username.trim();
    if (!username || username.length > 80 || input.password.length < 12 || input.password.length > 128) {
      throw new ConflictException('登录账号信息不合法');
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { username, passwordHash, role: UserRole.TEACHER },
          select: { id: true },
        });
        const bound = await tx.teacher.updateMany({
          where: { id, userId: null },
          data: { userId: user.id },
        });
        if (bound.count !== 1) throw new ConflictException('教师已绑定登录账号或资料不存在');
        const teacher = await tx.teacher.findUnique({ where: { id }, select: TEACHER_SUMMARY_SELECT });
        if (!teacher) throw new ConflictException('教师已绑定登录账号或资料不存在');
        return toSummary(teacher);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ConflictException('用户名已存在');
      throw error;
    }
  }

  async createProfile(input: CreateTeacherProfileInput): Promise<TeacherSummary> {
    return this.createProfileInTransaction(this.prisma, input);
  }

  previewCreateProfile(input: CreateTeacherProfileInput): CreateTeacherProfileInput {
    validateCompensation(input);
    return { ...input, name: validateName(input.name) };
  }

  async previewUpdateCompensation(id: string, input: UpdateTeacherCompensationInput): Promise<TeacherCompensationPreview> {
    validateCompensation(input);
    const teacher = await this.prisma.teacher.findUnique({ where: { id }, select: { ...TEACHER_SUMMARY_SELECT, updatedAt: true } });
    if (!teacher) throw new ConflictException('老师不存在');
    return {
      teacher: toSummary(teacher),
      updatedAt: teacher.updatedAt,
      nextBaseSalary: input.defaultBaseSalary.toFixed(2),
      nextCommissionRate: input.defaultCommissionRate.toFixed(4),
    };
  }

  /** Creates a teacher profile using a transaction owned by the calling workflow. */
  async createProfileInTransaction(tx: TeacherTransaction, input: CreateTeacherProfileInput): Promise<TeacherSummary> {
    const compensation = {
      defaultBaseSalary: input.defaultBaseSalary,
      defaultCommissionRate: input.defaultCommissionRate,
    };
    validateCompensation(compensation);
    const teacher = await tx.teacher.create({
      data: { name: validateName(input.name), ...compensation },
      select: TEACHER_SUMMARY_SELECT,
    });
    return toSummary(teacher);
  }

  async list(): Promise<TeacherSummary[]> {
    const teachers = await this.prisma.teacher.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      select: TEACHER_SUMMARY_SELECT,
    });
    return teachers.map(toSummary);
  }

  async updateCompensation(id: string, input: UpdateTeacherCompensationInput): Promise<TeacherSummary> {
    return this.updateCompensationInTransaction(this.prisma, id, input);
  }

  /** Updates compensation using a transaction owned by the calling workflow. */
  async updateCompensationInTransaction(tx: TeacherTransaction, id: string, input: UpdateTeacherCompensationInput, expectedUpdatedAt?: Date): Promise<TeacherSummary> {
    validateCompensation(input);
    try {
      if (expectedUpdatedAt) {
        const changed = await tx.teacher.updateMany({
          where: { id, updatedAt: expectedUpdatedAt },
          data: { defaultBaseSalary: input.defaultBaseSalary, defaultCommissionRate: input.defaultCommissionRate },
        });
        if (changed.count !== 1) throw new ConflictException('老师资料已变化，请重新预览');
        const updated = await tx.teacher.findUnique({ where: { id }, select: TEACHER_SUMMARY_SELECT });
        if (!updated) throw new ConflictException('老师不存在');
        return toSummary(updated);
      }
      const teacher = await tx.teacher.update({
        where: { id },
        data: { defaultBaseSalary: input.defaultBaseSalary, defaultCommissionRate: input.defaultCommissionRate },
        select: TEACHER_SUMMARY_SELECT,
      });
      return toSummary(teacher);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictException('老师不存在');
      }
      throw error;
    }
  }
}
