import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type CreateStudentCourseAccountInput = {
  courseId: string;
  currentUnitPrice?: Prisma.Decimal | undefined;
};

export type UpdateStudentCourseAccountPriceInput = {
  currentUnitPrice: Prisma.Decimal;
};

export type OpenAccountSnapshot = { studentUpdatedAt: Date; courseUpdatedAt: Date };

export type StudentCourseAccountSummary = {
  id: string;
  studentId: string;
  courseId: string;
  courseName: string;
  defaultDurationMinutes: number;
  currentUnitPrice: string;
  version: number;
};

const ACCOUNT_SELECT = {
  id: true,
  studentId: true,
  courseId: true,
  currentUnitPrice: true,
  version: true,
  course: { select: { name: true, defaultDurationMinutes: true } },
} as const;

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function toSummary(account: {
  id: string;
  studentId: string;
  courseId: string;
  currentUnitPrice: Prisma.Decimal;
  version: number;
  course: { name: string; defaultDurationMinutes: number };
}): StudentCourseAccountSummary {
  return {
    id: account.id,
    studentId: account.studentId,
    courseId: account.courseId,
    courseName: account.course.name,
    defaultDurationMinutes: account.course.defaultDurationMinutes,
    currentUnitPrice: account.currentUnitPrice.toFixed(2),
    version: account.version,
  };
}

@Injectable()
export class StudentCourseAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async previewOpen(studentId: string, input: CreateStudentCourseAccountInput) {
    const [student, course, existing] = await Promise.all([
      this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true, name: true, updatedAt: true } }),
      this.prisma.course.findUnique({ where: { id: input.courseId }, select: { id: true, name: true, defaultUnitPrice: true, defaultDurationMinutes: true, updatedAt: true } }),
      this.prisma.studentCourseAccount.findUnique({ where: { studentId_courseId: { studentId, courseId: input.courseId } }, select: { id: true } }),
    ]);
    if (!student) throw new NotFoundException('学生不存在');
    if (!course) throw new NotFoundException('课程不存在');
    if (existing) throw new ConflictException('学生已开通该课程账户');
    const price = input.currentUnitPrice ?? course.defaultUnitPrice;
    this.validatePrice(price);
    return {
      input: { courseId: input.courseId, currentUnitPrice: price.toFixed(2) },
      resourceVersions: { studentId, studentUpdatedAt: student.updatedAt.toISOString(), courseId: course.id, courseUpdatedAt: course.updatedAt.toISOString() },
      display: { studentName: student.name, courseName: course.name, currentUnitPrice: price.toFixed(2), defaultDurationMinutes: course.defaultDurationMinutes },
    };
  }

  async previewPrice(accountId: string, input: UpdateStudentCourseAccountPriceInput) {
    this.validatePrice(input.currentUnitPrice);
    const account = await this.prisma.studentCourseAccount.findUnique({ where: { id: accountId }, select: {
      id: true, version: true, currentUnitPrice: true, course: { select: { name: true } },
    } });
    if (!account) throw new NotFoundException('学生课程账户不存在');
    return {
      input: { currentUnitPrice: input.currentUnitPrice.toFixed(2) },
      resourceVersions: { accountId, version: account.version },
      display: { courseName: account.course.name, priceBefore: account.currentUnitPrice.toFixed(2), priceAfter: input.currentUnitPrice.toFixed(2) },
    };
  }

  async openInTransaction(tx: Prisma.TransactionClient, studentId: string, input: CreateStudentCourseAccountInput, expected: OpenAccountSnapshot) {
    await tx.$queryRaw`SELECT "id" FROM "Student" WHERE "id" = ${studentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Course" WHERE "id" = ${input.courseId} FOR UPDATE`;
    const [student, course] = await Promise.all([
      tx.student.findUnique({ where: { id: studentId }, select: { updatedAt: true } }),
      tx.course.findUnique({ where: { id: input.courseId }, select: { defaultUnitPrice: true, updatedAt: true } }),
    ]);
    if (!student) throw new NotFoundException('学生不存在');
    if (!course) throw new NotFoundException('课程不存在');
    if (student.updatedAt.getTime() !== expected.studentUpdatedAt.getTime() || course.updatedAt.getTime() !== expected.courseUpdatedAt.getTime()) {
      throw new ConflictException('学生或课程资料已变化，请重新预览');
    }
    const price = input.currentUnitPrice ?? course.defaultUnitPrice;
    this.validatePrice(price);
    try {
      const account = await tx.studentCourseAccount.create({
        data: { studentId, courseId: input.courseId, currentUnitPrice: price },
        select: ACCOUNT_SELECT,
      });
      return toSummary(account);
    } catch (error) {
      if (isPrismaError(error, 'P2002')) throw new ConflictException('学生已开通该课程账户');
      if (isPrismaError(error, 'P2003')) throw new NotFoundException('学生或课程不存在');
      throw error;
    }
  }

  async updatePriceInTransaction(tx: Prisma.TransactionClient, accountId: string, input: UpdateStudentCourseAccountPriceInput, expectedVersion?: number) {
    this.validatePrice(input.currentUnitPrice);
    const current = await tx.studentCourseAccount.findUnique({ where: { id: accountId }, select: { version: true } });
    if (!current) throw new NotFoundException('学生课程账户不存在');
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new ConflictException('课程账户价格已变化，请重新预览');
    const version = expectedVersion ?? current.version;
    const result = await tx.studentCourseAccount.updateMany({
      where: { id: accountId, version },
      data: { currentUnitPrice: input.currentUnitPrice, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new ConflictException('课程账户价格已变化，请重新预览');
    const account = await tx.studentCourseAccount.findUnique({ where: { id: accountId }, select: ACCOUNT_SELECT });
    if (!account) throw new NotFoundException('学生课程账户不存在');
    return toSummary(account);
  }

  private validatePrice(price: Prisma.Decimal): void {
    if (!price.isFinite() || !price.gt(0) || price.decimalPlaces() > 2) throw new BadRequestException('课程单价必须是大于零的两位小数');
  }

  async create(studentId: string, input: CreateStudentCourseAccountInput): Promise<StudentCourseAccountSummary> {
    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const student = await tx.student.findUnique({ where: { id: studentId }, select: { updatedAt: true } });
        const course = await tx.course.findUnique({
          where: { id: input.courseId },
          select: { defaultUnitPrice: true, updatedAt: true },
        });
        if (!student) throw new NotFoundException('学生不存在');
        if (!course) throw new NotFoundException('课程不存在');
        return this.openInTransaction(tx, studentId, input, { studentUpdatedAt: student.updatedAt, courseUpdatedAt: course.updatedAt });
      });
      return account;
    } catch (error) {
      if (isPrismaError(error, 'P2002')) throw new ConflictException('学生已开通该课程账户');
      if (isPrismaError(error, 'P2003')) throw new NotFoundException('学生不存在');
      throw error;
    }
  }

  async listForStudent(studentId: string): Promise<StudentCourseAccountSummary[]> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true },
    });
    if (!student) throw new NotFoundException('学生不存在');
    const accounts = await this.prisma.studentCourseAccount.findMany({
      where: { studentId },
      orderBy: [{ course: { name: 'asc' } }, { id: 'asc' }],
      select: ACCOUNT_SELECT,
    });
    return accounts.map(toSummary);
  }

  async updatePrice(
    accountId: string,
    input: UpdateStudentCourseAccountPriceInput,
  ): Promise<StudentCourseAccountSummary> {
    try {
      return await this.prisma.$transaction((tx) => this.updatePriceInTransaction(tx, accountId, input));
    } catch (error) {
      if (isPrismaError(error, 'P2025')) throw new NotFoundException('学生课程账户不存在');
      throw error;
    }
  }
}
