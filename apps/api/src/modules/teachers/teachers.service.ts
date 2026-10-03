import { Injectable, NotFoundException } from '@nestjs/common';
import { money } from '../../common/money.js';
import { Prisma, TeacherStatus } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateTeacherDto } from './dto/create-teacher.dto.js';
import { UpdateTeacherDto } from './dto/update-teacher.dto.js';

/**
 * 授课老师档案（US-BD-03）。
 *
 * **不提供删除接口**：老师被排课 / 工资表引用，删掉会破坏历史记录，
 * 不再授课改为停用（status=INACTIVE）即可。
 *
 * 岗位 position 是自由文本，没有枚举 —— 业务上不存在「店长」这种岗位，
 * 代码里也就不该出现对应的约束或分支。
 */
@Injectable()
export class TeachersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number, pageSize: number, status?: TeacherStatus) {
    const where: { status?: TeacherStatus } = {};
    if (status !== undefined) where.status = status;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.teacher.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.teacher.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async getById(id: string) {
    const found = await this.prisma.teacher.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('老师不存在');
    return found;
  }

  async create(dto: CreateTeacherDto) {
    return this.prisma.teacher.create({
      data: {
        name: dto.name,
        position: dto.position ?? null,
        hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : null,
        status: dto.status ?? TeacherStatus.ACTIVE,
        // 金额 / 比例只在这一步入 Decimal，之后全程 Decimal，绝不让 number 参与运算。
        commissionRate: toNullableDecimal(dto.commissionRate),
        defaultBaseSalary: toNullableDecimal(dto.defaultBaseSalary),
      },
    });
  }

  async update(id: string, dto: UpdateTeacherDto) {
    await this.getById(id);

    const data: {
      name?: string;
      position?: string | null;
      hiredAt?: Date | null;
      status?: TeacherStatus;
      commissionRate?: Prisma.Decimal | null;
      defaultBaseSalary?: Prisma.Decimal | null;
    } = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.position !== undefined) data.position = dto.position;
    if (dto.hiredAt !== undefined) data.hiredAt = dto.hiredAt ? new Date(dto.hiredAt) : null;
    if (dto.status !== undefined) data.status = dto.status;
    // undefined = 不改；null = 清空；数值 = 改成该值。
    if (dto.commissionRate !== undefined) {
      data.commissionRate = toNullableDecimal(dto.commissionRate);
    }
    if (dto.defaultBaseSalary !== undefined) {
      data.defaultBaseSalary = toNullableDecimal(dto.defaultBaseSalary);
    }

    return this.prisma.teacher.update({ where: { id }, data });
  }
}

function toNullableDecimal(
  value: Prisma.Decimal | string | number | null | undefined,
): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  return money(value);
}
