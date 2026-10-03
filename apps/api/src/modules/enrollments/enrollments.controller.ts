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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto.js';
import { ListEnrollmentsQueryDto } from './dto/list-enrollments.dto.js';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto.js';
import { EnrollmentsService } from './enrollments.service.js';

/** 报名与自定义课程价格（US-BD-05）。基础资料整块只对店主开放。 */
@Controller('enrollments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get()
  list(@Query() query: ListEnrollmentsQueryDto) {
    return this.enrollments.list(query.page, query.pageSize, query.studentId);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.enrollments.getById(id);
  }

  @Post()
  create(@Body() dto: CreateEnrollmentDto) {
    return this.enrollments.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEnrollmentDto) {
    return this.enrollments.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.enrollments.remove(id);
  }
}
