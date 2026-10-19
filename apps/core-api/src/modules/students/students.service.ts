import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const STUDENT_PUBLIC_SELECT = {
  id: true,
  name: true,
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
  notes: string | null;
  enrollmentStatus: StudentEnrollmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateStudentInput = {
  name: string;
  notes?: string | null;
};

export type UpdateStudentInput = {
  name?: string;
  notes?: string | null;
};

function isMissingRecordError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

function toSummary(student: Prisma.StudentGetPayload<{ select: typeof STUDENT_PUBLIC_SELECT }>): StudentSummary {
  const now = new Date();
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
    : referenceAt && now.getTime() - referenceAt.getTime() <= threshold
      ? 'STUDYING'
      : 'FROZEN';
  return {
    id: student.id,
    name: student.name,
    notes: student.notes,
    enrollmentStatus,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  };
}

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateStudentInput): Promise<StudentSummary> {
    const student = await this.prisma.student.create({
      data: {
        name: input.name.trim(),
        notes: input.notes?.trim() ?? null,
      },
      select: STUDENT_PUBLIC_SELECT,
    });
    return toSummary(student);
  }

  async list(): Promise<StudentSummary[]> {
    const students = await this.prisma.student.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: STUDENT_PUBLIC_SELECT,
    });
    return students.map(toSummary);
  }

  async update(id: string, input: UpdateStudentInput): Promise<StudentSummary> {
    const data: Prisma.StudentUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.notes !== undefined) data.notes = input.notes?.trim() ?? null;

    try {
      const student = await this.prisma.student.update({
        where: { id },
        data,
        select: STUDENT_PUBLIC_SELECT,
      });
      return toSummary(student);
    } catch (error) {
      if (isMissingRecordError(error)) throw new NotFoundException('学生不存在');
      throw error;
    }
  }
}
