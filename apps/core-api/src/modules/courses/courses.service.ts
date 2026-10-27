import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  async previewCreate(input: CreateCourseInput) {
    const normalized = this.normalizeCreate(input);
    return { input: normalized };
  }

  async previewUpdate(id: string, input: UpdateCourseInput) {
    const normalized = this.normalizeUpdate(input);
    const course = await this.prisma.course.findUnique({ where: { id }, select: { id: true, name: true, defaultUnitPrice: true, defaultDurationMinutes: true, isActive: true, updatedAt: true } });
    if (!course) throw new NotFoundException('课程不存在');
    return {
      input: normalized,
      resourceVersions: { courseId: course.id, updatedAt: course.updatedAt.toISOString() },
      display: {
        nameBefore: course.name, ...(normalized.name !== undefined ? { nameAfter: normalized.name } : {}),
        ...(normalized.defaultUnitPrice !== undefined ? { priceBefore: course.defaultUnitPrice.toFixed(2), priceAfter: normalized.defaultUnitPrice.toFixed(2) } : {}),
        ...(normalized.defaultDurationMinutes !== undefined ? { durationBefore: course.defaultDurationMinutes, durationAfter: normalized.defaultDurationMinutes } : {}),
        ...(normalized.isActive !== undefined ? { isActiveBefore: course.isActive, isActiveAfter: normalized.isActive } : {}),
      },
    };
  }

  async createInTransaction(tx: Prisma.TransactionClient, input: CreateCourseInput): Promise<CourseSummary> {
    const normalized = this.normalizeCreate(input);
    const course = await tx.course.create({
      data: normalized,
      select: COURSE_SELECT,
    });
    return toSummary(course);
  }

  async updateInTransaction(tx: Prisma.TransactionClient, id: string, input: UpdateCourseInput, expectedUpdatedAt: Date): Promise<CourseSummary> {
    const normalized = this.normalizeUpdate(input);
    const data: Prisma.CourseUpdateInput = {};
    if (normalized.name !== undefined) data.name = normalized.name;
    if (normalized.defaultUnitPrice !== undefined) data.defaultUnitPrice = normalized.defaultUnitPrice;
    if (normalized.defaultDurationMinutes !== undefined) data.defaultDurationMinutes = normalized.defaultDurationMinutes;
    if (normalized.isActive !== undefined) data.isActive = normalized.isActive;
    const result = await tx.course.updateMany({ where: { id, updatedAt: expectedUpdatedAt }, data });
    if (result.count !== 1) {
      const exists = await tx.course.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('课程不存在');
      throw new ConflictException('课程资料已变化，请重新预览');
    }
    const course = await tx.course.findUnique({ where: { id }, select: COURSE_SELECT });
    if (!course) throw new NotFoundException('课程不存在');
    return toSummary(course);
  }

  private normalizeCreate(input: CreateCourseInput): CreateCourseInput {
    const name = input.name.trim();
    this.validateCourse(name, input.defaultUnitPrice, input.defaultDurationMinutes);
    return { name, defaultUnitPrice: input.defaultUnitPrice, defaultDurationMinutes: input.defaultDurationMinutes };
  }

  private normalizeUpdate(input: UpdateCourseInput): UpdateCourseInput {
    const normalized: UpdateCourseInput = { ...input };
    if (normalized.name !== undefined) normalized.name = normalized.name.trim();
    if (Object.keys(normalized).length === 0) throw new BadRequestException('至少需要修改一项课程资料');
    this.validateCourse(normalized.name, normalized.defaultUnitPrice, normalized.defaultDurationMinutes);
    return normalized;
  }

  private validateCourse(name: string | undefined, price: Prisma.Decimal | undefined, duration: number | undefined): void {
    if (name !== undefined && (!name || name.length > 120)) throw new BadRequestException('课程名称长度必须为 1 至 120 个字符');
    if (price !== undefined && (!price.isFinite() || !price.gt(0) || price.decimalPlaces() > 2)) throw new BadRequestException('课程默认单价必须是大于零的两位小数');
    if (duration !== undefined && (!Number.isInteger(duration) || duration <= 0 || duration > 480)) throw new BadRequestException('课程时长必须为 1 至 480 分钟');
  }

  async create(input: CreateCourseInput): Promise<CourseSummary> {
    return this.prisma.$transaction((tx) => this.createInTransaction(tx, input));
  }

  async list(): Promise<CourseSummary[]> {
    const courses = await this.prisma.course.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      select: COURSE_SELECT,
    });
    return courses.map(toSummary);
  }

  async update(id: string, input: UpdateCourseInput): Promise<CourseSummary> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.course.findUnique({ where: { id }, select: { updatedAt: true } });
        if (!current) throw new NotFoundException('课程不存在');
        return this.updateInTransaction(tx, id, input, current.updatedAt);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('课程不存在');
      }
      throw error;
    }
  }
}
