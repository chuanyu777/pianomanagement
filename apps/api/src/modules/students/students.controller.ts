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
import { CreateStudentDto } from './dto/create-student.dto.js';
import { ListStudentsQueryDto } from './dto/list-students.dto.js';
import { UpdateStudentDto } from './dto/update-student.dto.js';
import { StudentsService } from './students.service.js';

/** 学生档案（US-BD-04）。基础资料整块只对店主开放。 */
@Controller('students')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  list(@Query() query: ListStudentsQueryDto) {
    return this.students.list(query.page, query.pageSize, query.status);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.students.getById(id);
  }

  @Post()
  create(@Body() dto: CreateStudentDto) {
    return this.students.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStudentDto) {
    return this.students.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.students.remove(id);
  }
}
