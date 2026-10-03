import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { StudentStatus } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateStudentDto } from './dto/create-student.dto.js';
import { UpdateStudentDto } from './dto/update-student.dto.js';

/**
 * 学生档案（US-BD-04）。
 *
 * gradeLevel 仅用于教学分级展示，**不参与任何定价计算** —— 这里没有、
 * 也不该有「级别 → 价格」的映射（定价只认 Enrollment.unitPrice）。
 *
 * 删除是硬删，但学生身上一旦挂过排课 / 退费 / 台账流水就不能删：
 * Enrollment 是 onDelete: Cascade，删学生会把报名关系和台账一起级联掉，
 * 等于抹掉历史账。所以先查历史，有就 409 引导改为 WITHDRAWN 停学。
 */
@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number, pageSize: number, status?: StudentStatus) {
    const where: { status?: StudentStatus } = {};
    if (status !== undefined) where.status = status;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.student.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async getById(id: string) {
    const found = await this.prisma.student.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('学生不存在');
    return found;
  }

  async create(dto: CreateStudentDto) {
    return this.prisma.student.create({
      data: {
        name: dto.name,
        gradeLevel: dto.gradeLevel,
        status: dto.status ?? StudentStatus.ENROLLED,
        wantsRefund: dto.wantsRefund ?? false,
        note: dto.note ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateStudentDto) {
    await this.getById(id);

    const data: {
      name?: string;
      gradeLevel?: number;
      status?: StudentStatus;
      wantsRefund?: boolean;
      note?: string | null;
    } = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.gradeLevel !== undefined) data.gradeLevel = dto.gradeLevel;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.wantsRefund !== undefined) data.wantsRefund = dto.wantsRefund;
    if (dto.note !== undefined) data.note = dto.note;

    return this.prisma.student.update({ where: { id }, data });
  }

  async remove(id: string): Promise<void> {
    await this.getById(id);

    const [lessonCount, refundCount, ledgerCount] = await this.prisma.$transaction([
      this.prisma.lesson.count({ where: { studentId: id } }),
      this.prisma.refundRecord.count({ where: { studentId: id } }),
      this.prisma.ledgerEntry.count({ where: { enrollment: { studentId: id } } }),
    ]);

    if (lessonCount > 0 || refundCount > 0 || ledgerCount > 0) {
      throw new ConflictException(
        `该学生已有 ${lessonCount} 节课、${refundCount} 笔退费、${ledgerCount} 条台账流水，不能删除；不再就读请把状态改为 WITHDRAWN`,
      );
    }

    await this.prisma.student.delete({ where: { id } });
  }
}
