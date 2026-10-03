import {
  Body,
  Controller,
  Get,
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
import { CreateTeacherDto } from './dto/create-teacher.dto.js';
import { ListTeachersQueryDto } from './dto/list-teachers.dto.js';
import { UpdateTeacherDto } from './dto/update-teacher.dto.js';
import { TeachersService } from './teachers.service.js';

/** 老师档案（US-BD-03）。基础资料整块只对店主开放；停用走 PATCH status=INACTIVE。 */
@Controller('teachers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Get()
  list(@Query() query: ListTeachersQueryDto) {
    return this.teachers.list(query.page, query.pageSize, query.status);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.teachers.getById(id);
  }

  @Post()
  create(@Body() dto: CreateTeacherDto) {
    return this.teachers.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTeacherDto) {
    return this.teachers.update(id, dto);
  }
}
