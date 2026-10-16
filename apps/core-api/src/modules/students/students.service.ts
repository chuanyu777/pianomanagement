import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const STUDENT_PUBLIC_SELECT = {
  id: true,
  name: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.StudentSelect;

export type StudentSummary = {
  id: string;
  name: string;
  notes: string | null;
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

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateStudentInput): Promise<StudentSummary> {
    return this.prisma.student.create({
      data: {
        name: input.name.trim(),
        notes: input.notes?.trim() ?? null,
      },
      select: STUDENT_PUBLIC_SELECT,
    });
  }

  async list(): Promise<StudentSummary[]> {
    return this.prisma.student.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: STUDENT_PUBLIC_SELECT,
    });
  }

  async update(id: string, input: UpdateStudentInput): Promise<StudentSummary> {
    const data: Prisma.StudentUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.notes !== undefined) data.notes = input.notes?.trim() ?? null;

    try {
      return await this.prisma.student.update({
        where: { id },
        data,
        select: STUDENT_PUBLIC_SELECT,
      });
    } catch (error) {
      if (isMissingRecordError(error)) throw new NotFoundException('学生不存在');
      throw error;
    }
  }
}
