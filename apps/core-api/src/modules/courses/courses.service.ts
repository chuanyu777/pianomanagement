import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type CreateCourseInput = {
  name: string;
  defaultUnitPrice: Prisma.Decimal;
  defaultDurationMinutes: number;
};

export type UpdateCourseInput = Partial<CreateCourseInput> & {
  isActive?: boolean;
};

export type CourseSummary = {
  id: string;
  name: string;
  defaultUnitPrice: string;
  defaultDurationMinutes: number;
  isActive: boolean;
};

type CourseRecord = {
  id: string;
  name: string;
  defaultUnitPrice: Prisma.Decimal;
  defaultDurationMinutes: number;
  isActive: boolean;
};

const COURSE_SELECT = {
  id: true,
  name: true,
  defaultUnitPrice: true,
  defaultDurationMinutes: true,
  isActive: true,
} as const;

function toSummary(course: CourseRecord): CourseSummary {
  return {
    id: course.id,
    name: course.name,
    defaultUnitPrice: course.defaultUnitPrice.toFixed(2),
    defaultDurationMinutes: course.defaultDurationMinutes,
    isActive: course.isActive,
  };
}

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateCourseInput): Promise<CourseSummary> {
    const course = await this.prisma.course.create({
      data: {
        name: input.name.trim(),
        defaultUnitPrice: input.defaultUnitPrice,
        defaultDurationMinutes: input.defaultDurationMinutes,
      },
      select: COURSE_SELECT,
    });
    return toSummary(course);
  }

  async list(): Promise<CourseSummary[]> {
    const courses = await this.prisma.course.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      select: COURSE_SELECT,
    });
    return courses.map(toSummary);
  }

  async update(id: string, input: UpdateCourseInput): Promise<CourseSummary> {
    const data: Prisma.CourseUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.defaultUnitPrice !== undefined) {
      data.defaultUnitPrice = input.defaultUnitPrice;
    }
    if (input.defaultDurationMinutes !== undefined) {
      data.defaultDurationMinutes = input.defaultDurationMinutes;
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;

    try {
      const course = await this.prisma.course.update({
        where: { id },
        data,
        select: COURSE_SELECT,
      });
      return toSummary(course);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('课程不存在');
      }
      throw error;
    }
  }
}
