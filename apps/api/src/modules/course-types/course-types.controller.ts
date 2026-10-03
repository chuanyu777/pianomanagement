import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CourseTypesService } from './course-types.service.js';
import { CreateCourseTypeDto } from './dto/create-course-type.dto.js';
import { UpdateCourseTypeDto } from './dto/update-course-type.dto.js';

/**
 * 课程类型维护（US-BD-01）。基础资料整块只对店主开放。
 * JwtAuthGuard 管「有没有登录」，RolesGuard 管「角色够不够」，两个一起挂才完整。
 */
@Controller('course-types')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class CourseTypesController {
  constructor(private readonly courseTypes: CourseTypesService) {}

  @Get()
  list() {
    return this.courseTypes.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.courseTypes.getById(id);
  }

  @Post()
  create(@Body() dto: CreateCourseTypeDto) {
    return this.courseTypes.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCourseTypeDto) {
    return this.courseTypes.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.courseTypes.remove(id);
  }
}
