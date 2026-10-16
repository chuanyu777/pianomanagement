import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type CreateStudentCourseAccountInput = {
  courseId: string;
  currentUnitPrice?: Prisma.Decimal | undefined;
};

export type UpdateStudentCourseAccountPriceInput = {
  currentUnitPrice: Prisma.Decimal;
};

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

  async create(studentId: string, input: CreateStudentCourseAccountInput): Promise<StudentCourseAccountSummary> {
    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const course = await tx.course.findUnique({
          where: { id: input.courseId },
          select: { defaultUnitPrice: true },
        });
        if (!course) throw new NotFoundException('课程不存在');
        return tx.studentCourseAccount.create({
          data: {
            studentId,
            courseId: input.courseId,
            currentUnitPrice: input.currentUnitPrice ?? course.defaultUnitPrice,
          },
          select: ACCOUNT_SELECT,
        });
      });
      return toSummary(account);
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
      const account = await this.prisma.$transaction((tx) => tx.studentCourseAccount.update({
        where: { id: accountId },
        data: { currentUnitPrice: input.currentUnitPrice, version: { increment: 1 } },
        select: ACCOUNT_SELECT,
      }));
      return toSummary(account);
    } catch (error) {
      if (isPrismaError(error, 'P2025')) throw new NotFoundException('学生课程账户不存在');
      throw error;
    }
  }
}
