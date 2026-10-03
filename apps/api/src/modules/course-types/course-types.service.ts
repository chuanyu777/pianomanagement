import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateCourseTypeDto } from './dto/create-course-type.dto.js';
import { UpdateCourseTypeDto } from './dto/update-course-type.dto.js';

/**
 * Prisma 唯一约束冲突的错误码。用鸭子类型判断而不是 import 生成产物的错误类，
 * 生成产物换结构时这里不会跟着炸。
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * 课程类型维护（US-BD-01）。
 *
 * 删除是硬删，但必须先确认没有被报名关系 / 排课引用 ——
 * Enrollment 与 Lesson 都以 Restrict 指向 CourseType，被引用时数据库会拒绝删除，
 * 但那个报错前端看不懂。所以这里先查引用、给出能读懂的原因（「已被 N 条报名引用」），
 * 引导改为停用。查与删之间仍有并发窗口，数据库的 Restrict 是最后一道兜底。
 */
@Injectable()
export class CourseTypesService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.courseType.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async getById(id: string) {
    const found = await this.prisma.courseType.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('课程类型不存在');
    return found;
  }

  async create(dto: CreateCourseTypeDto) {
    try {
      return await this.prisma.courseType.create({
        data: {
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (error) {
      // 重名靠数据库唯一约束兜底，而不是「先查再插」—— 并发下先查再插必然漏。
      if (isUniqueViolation(error)) {
        throw new ConflictException(`课程类型「${dto.name}」已存在`);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateCourseTypeDto) {
    await this.getById(id);

    const data: { name?: string; sortOrder?: number; isActive?: boolean } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.courseType.update({ where: { id }, data });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`课程类型「${dto.name}」已存在`);
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await this.getById(id);

    const [enrollmentCount, lessonCount] = await this.prisma.$transaction([
      this.prisma.enrollment.count({ where: { courseTypeId: id } }),
      this.prisma.lesson.count({ where: { courseTypeId: id } }),
    ]);

    if (enrollmentCount > 0 || lessonCount > 0) {
      throw new ConflictException(
        `课程类型已被 ${enrollmentCount} 条报名关系、${lessonCount} 节课引用，不能删除；不再使用请改为停用`,
      );
    }

    await this.prisma.courseType.delete({ where: { id } });
  }
}
