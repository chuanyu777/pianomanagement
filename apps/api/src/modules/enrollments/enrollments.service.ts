import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { money, ZERO } from '../../common/money.js';
import { Prisma, StudentStatus, TeacherStatus } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto.js';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto.js';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * 单价必须 > 0。
 *
 * 为 0 时「预计剩余课时 = 余额 ÷ 单价」会除零，为负则整条台账方向都反了。
 * 这是业务规则，挡在 service 入口，不依赖前端校验。
 */
function toPositiveUnitPrice(value: Prisma.Decimal | string | number): Prisma.Decimal {
  const price = money(value);
  if (price.lessThanOrEqualTo(ZERO)) {
    throw new BadRequestException('单价必须大于 0：单价为 0 时「预计剩余课时」会除零');
  }
  return price;
}

/**
 * 报名与自定义课程价格（US-BD-05）。
 *
 * 一条 Enrollment 就是台账的记账维度：学生 + 老师 + 课程 + 该学生此课程的自定义单价。
 * (studentId, teacherId, courseTypeId) 由数据库的 enrollment_identity 唯一约束保证唯一。
 *
 * **改单价不影响历史消费**：历史课单价在确认时锁定进 Lesson.unitPriceSnapshot，
 * 这里改价只写 enrollment，绝不回写 lesson（回写会把历史账改掉，且不报错）。
 */
@Injectable()
export class EnrollmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number, pageSize: number, studentId?: string) {
    const where: { studentId?: string } = {};
    if (studentId !== undefined) where.studentId = studentId;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.enrollment.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async getById(id: string) {
    const found = await this.prisma.enrollment.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('报名关系不存在');
    return found;
  }

  async create(dto: CreateEnrollmentDto) {
    const unitPrice = toPositiveUnitPrice(dto.unitPrice);

    // 引用校验：三条都查到 + 状态可用，才允许建立报名关系。
    const [student, teacher, courseType] = await Promise.all([
      this.prisma.student.findUnique({ where: { id: dto.studentId } }),
      this.prisma.teacher.findUnique({ where: { id: dto.teacherId } }),
      this.prisma.courseType.findUnique({ where: { id: dto.courseTypeId } }),
    ]);

    if (!student) throw new NotFoundException('学生不存在');
    if (!teacher) throw new NotFoundException('老师不存在');
    if (!courseType) throw new NotFoundException('课程类型不存在');

    if (student.status === StudentStatus.WITHDRAWN) {
      throw new BadRequestException('该学生已退学，不能新建报名关系');
    }
    if (teacher.status !== TeacherStatus.ACTIVE) {
      throw new BadRequestException('该老师已停用，不能新建报名关系');
    }
    if (!courseType.isActive) {
      throw new BadRequestException('该课程类型已停用，不能新建报名关系');
    }

    try {
      return await this.prisma.enrollment.create({
        data: {
          studentId: dto.studentId,
          teacherId: dto.teacherId,
          courseTypeId: dto.courseTypeId,
          unitPrice,
          effectiveFrom: new Date(dto.effectiveFrom),
          effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
          initialPaidBalance: money(dto.initialPaidBalance),
          initialGiftBalance: money(dto.initialGiftBalance),
        },
      });
    } catch (error) {
      // 唯一性靠数据库约束兜底，而不是「先查再插」—— 并发下先查再插必然漏。
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          '该学生在这位老师的这门课程下已有一条报名关系，不能重复报名；请改为修改原关系的单价',
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateEnrollmentDto) {
    await this.getById(id);

    const data: {
      unitPrice?: Prisma.Decimal;
      effectiveFrom?: Date;
      effectiveTo?: Date | null;
    } = {};

    if (dto.unitPrice !== undefined) data.unitPrice = toPositiveUnitPrice(dto.unitPrice);
    if (dto.effectiveFrom !== undefined) data.effectiveFrom = new Date(dto.effectiveFrom);
    if (dto.effectiveTo !== undefined) {
      data.effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;
    }

    // 只更新 enrollment 本身；已确认课的 unitPriceSnapshot 原样不动。
    return this.prisma.enrollment.update({ where: { id }, data });
  }

  async remove(id: string): Promise<void> {
    await this.getById(id);

    const [lessonCount, ledgerCount] = await this.prisma.$transaction([
      this.prisma.lesson.count({ where: { enrollmentId: id } }),
      this.prisma.ledgerEntry.count({ where: { enrollmentId: id } }),
    ]);

    if (lessonCount > 0 || ledgerCount > 0) {
      throw new ConflictException(
        `该报名关系已有 ${lessonCount} 节课、${ledgerCount} 条台账流水，不能删除；不再使用请调整生效区间`,
      );
    }

    await this.prisma.enrollment.delete({ where: { id } });
  }
}
