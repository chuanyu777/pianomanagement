import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { businessNow } from '../../common/time/business-clock.js';

const STUDENT_PUBLIC_SELECT = {
  id: true,
  name: true,
  phone: true,
  notes: true,
  withdrawnAt: true,
  createdAt: true,
  updatedAt: true,
  courseAccounts: {
    select: {
      createdAt: true,
      lessons: {
        where: { status: 'COMPLETED' },
        select: { completedAt: true },
      },
    },
  },
} satisfies Prisma.StudentSelect;

export type StudentEnrollmentStatus = 'STUDYING' | 'FROZEN' | 'WITHDRAWN';

export type StudentSummary = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  enrollmentStatus: StudentEnrollmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateStudentInput = {
  name: string;
  phone?: string | null;
  notes?: string | null;
};

export type UpdateStudentInput = {
  name?: string;
  phone?: string | null;
  notes?: string | null;
};

function isMissingRecordError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

function toSummary(student: Prisma.StudentGetPayload<{ select: typeof STUDENT_PUBLIC_SELECT }>, now = businessNow()): StudentSummary {
  const threshold = 31 * 24 * 60 * 60 * 1000;
  const completedAt = student.courseAccounts
    .flatMap((account) => account.lessons)
    .map((lesson) => lesson.completedAt)
    .filter((value): value is Date => value !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const firstAccountCreatedAt = student.courseAccounts
    .map((account) => account.createdAt)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  const referenceAt = completedAt ?? firstAccountCreatedAt;
  const enrollmentStatus: StudentEnrollmentStatus = student.withdrawnAt
    ? 'WITHDRAWN'
    : !referenceAt || now.getTime() - referenceAt.getTime() <= threshold
      ? 'STUDYING'
      : 'FROZEN';
  return {
    id: student.id,
    name: student.name,
    phone: student.phone ?? null,
    notes: student.notes,
    enrollmentStatus,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  };
}

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async previewCreate(input: CreateStudentInput) {
    const normalized = this.normalizeCreate(input);
    return { input: normalized };
  }

  async previewUpdate(id: string, input: UpdateStudentInput) {
    const normalized = this.normalizeUpdate(input);
    const student = await this.prisma.student.findUnique({ where: { id }, select: { id: true, name: true, phone: true, notes: true, updatedAt: true } });
    if (!student) throw new NotFoundException('学生不存在');
    return {
      input: normalized,
      resourceVersions: { studentId: student.id, updatedAt: student.updatedAt.toISOString() },
      display: {
        nameBefore: student.name, ...(normalized.name !== undefined ? { nameAfter: normalized.name } : {}),
        ...(normalized.phone !== undefined ? { phoneBefore: student.phone, phoneAfter: normalized.phone } : {}),
        ...(normalized.notes !== undefined ? { notesBefore: student.notes, notesAfter: normalized.notes } : {}),
      },
    };
  }

  async createInTransaction(tx: Prisma.TransactionClient, input: CreateStudentInput): Promise<StudentSummary> {
    const normalized = this.normalizeCreate(input);
    const student = await tx.student.create({
      data: normalized,
      select: STUDENT_PUBLIC_SELECT,
    });
    return toSummary(student);
  }

  async updateInTransaction(tx: Prisma.TransactionClient, id: string, input: UpdateStudentInput, expectedUpdatedAt: Date): Promise<StudentSummary> {
    const normalized = this.normalizeUpdate(input);
    const data: Prisma.StudentUpdateInput = {};
    if (normalized.name !== undefined) data.name = normalized.name;
    if (normalized.phone !== undefined) data.phone = normalized.phone;
    if (normalized.notes !== undefined) data.notes = normalized.notes;
    const result = await tx.student.updateMany({ where: { id, updatedAt: expectedUpdatedAt }, data });
    if (result.count !== 1) {
      const exists = await tx.student.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('学生不存在');
      throw new ConflictException('学生资料已变化，请重新预览');
    }
    const student = await tx.student.findUnique({ where: { id }, select: STUDENT_PUBLIC_SELECT });
    if (!student) throw new NotFoundException('学生不存在');
    return toSummary(student);
  }

  private normalizeCreate(input: CreateStudentInput): CreateStudentInput {
    const name = input.name.trim();
    if (!name || name.length > 120) throw new BadRequestException('学生姓名长度必须为 1 至 120 个字符');
    const phone = this.normalizePhone(input.phone);
    const notes = input.notes?.trim() || null;
    if (notes && notes.length > 2000) throw new BadRequestException('学生备注不能超过 2000 个字符');
    return { name, phone, notes };
  }

  private normalizeUpdate(input: UpdateStudentInput): UpdateStudentInput {
    const normalized: UpdateStudentInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > 120) throw new BadRequestException('学生姓名长度必须为 1 至 120 个字符');
      normalized.name = name;
    }
    if (input.phone !== undefined) normalized.phone = this.normalizePhone(input.phone);
    if (input.notes !== undefined) {
      const notes = input.notes?.trim() || null;
      if (notes && notes.length > 2000) throw new BadRequestException('学生备注不能超过 2000 个字符');
      normalized.notes = notes;
    }
    if (Object.keys(normalized).length === 0) throw new BadRequestException('至少需要修改一项学生资料');
    return normalized;
  }

  private normalizePhone(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const normalized = value.trim().replace(/[\s-]/g, '');
    if (!normalized) return null;
    if (!/^\+?[0-9]{6,20}$/.test(normalized)) throw new BadRequestException('联系电话必须为 6 至 20 位数字，可带国家区号 +');
    return normalized;
  }

  async create(input: CreateStudentInput): Promise<StudentSummary> {
    return this.prisma.$transaction((tx) => this.createInTransaction(tx, input));
  }

  async list(query?: string): Promise<StudentSummary[]> {
    const students = await this.prisma.student.findMany({
      ...(query?.trim() ? { where: { OR: [{ name: { contains: query.trim(), mode: 'insensitive' } }, { phone: { contains: query.trim() } }] } } : {}),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: STUDENT_PUBLIC_SELECT,
    });
    return students.map((student) => toSummary(student));
  }

  async listPage(input: { q?: string | undefined; page: number; pageSize: number; enrollmentStatus?: StudentEnrollmentStatus | undefined; arrears?: boolean | undefined; locateStudentId?: string | undefined }) {
    const now = businessNow();
    const cutoff = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const completed = { status: 'COMPLETED' as const, completedAt: { not: null } };
    const frozen: Prisma.StudentWhereInput = {
      withdrawnAt: null,
      courseAccounts: { none: { lessons: { some: { status: 'COMPLETED', completedAt: { gte: cutoff } } } } },
      OR: [
        { courseAccounts: { some: { lessons: { some: completed } } } },
        { courseAccounts: { some: { createdAt: { lt: cutoff } } } },
      ],
    };
    return this.prisma.$transaction(async (tx) => {
      const conditions: Prisma.StudentWhereInput[] = [];
      if (input.q?.trim()) conditions.push({ OR: [{ name: { contains: input.q.trim(), mode: 'insensitive' } }, { phone: { contains: input.q.trim() } }] });
      if (input.enrollmentStatus === 'WITHDRAWN') conditions.push({ withdrawnAt: { not: null } });
      if (input.enrollmentStatus === 'FROZEN') conditions.push(frozen);
      if (input.enrollmentStatus === 'STUDYING') conditions.push({ withdrawnAt: null, NOT: frozen });
      if (input.arrears !== undefined) {
        const accounts = await tx.studentCourseAccount.findMany({
          where: { student: { withdrawnAt: null } },
          select: { studentId: true, openingPaidBalance: true, ledgerEntries: { select: { paidDelta: true } } },
        });
        const ids = [...new Set(accounts.filter((account) => account.ledgerEntries.reduce((sum, entry) => sum.add(entry.paidDelta), new Prisma.Decimal(account.openingPaidBalance)).isNegative()).map((account) => account.studentId))];
        conditions.push({ id: input.arrears ? { in: ids } : { notIn: ids } });
      }
      const where: Prisma.StudentWhereInput = { AND: conditions };
      const total = await tx.student.count({ where });
      let page = input.page;
      if (input.locateStudentId) {
        const target = await tx.student.findFirst({ where: { AND: [where, { id: input.locateStudentId }] }, select: { id: true, name: true } });
        if (!target) return { items: [], total, page: null, pageSize: input.pageSize };
        const preceding = await tx.student.count({ where: { AND: [where, { OR: [{ name: { lt: target.name } }, { name: target.name, id: { lt: target.id } }] }] } });
        page = Math.floor(preceding / input.pageSize) + 1;
      }
      const students = await tx.student.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (page - 1) * input.pageSize, take: input.pageSize, select: STUDENT_PUBLIC_SELECT });
      return { items: students.map((student) => toSummary(student, now)), total, page, pageSize: input.pageSize };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async get(id: string): Promise<StudentSummary> {
    const student = await this.prisma.student.findUnique({ where: { id }, select: STUDENT_PUBLIC_SELECT });
    if (!student) throw new NotFoundException('学生不存在');
    return toSummary(student);
  }

  async update(id: string, input: UpdateStudentInput): Promise<StudentSummary> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.student.findUnique({ where: { id }, select: { updatedAt: true } });
        if (!current) throw new NotFoundException('学生不存在');
        return this.updateInTransaction(tx, id, input, current.updatedAt);
      });
    } catch (error) {
      if (isMissingRecordError(error)) throw new NotFoundException('学生不存在');
      throw error;
    }
  }
}
