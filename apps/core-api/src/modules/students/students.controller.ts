import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { StudentsService, type StudentSummary } from './students.service.js';

class CreateStudentBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  name!: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 2000, nullable: true })
  notes?: string | null;
}

class UpdateStudentBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120, required: false })
  name?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 2000, nullable: true })
  notes?: string | null;
}

class StudentResponse implements StudentSummary {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

const NotesSchema = z.string().trim().min(1).max(2000).nullable().optional();

const CreateStudentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: NotesSchema,
}).strict();

const UpdateStudentBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: NotesSchema,
}).strict().refine((body) => body.name !== undefined || body.notes !== undefined);

@ApiTags('Students')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Post()
  @ApiBody({ type: CreateStudentBody })
  @ApiCreatedResponse({ type: StudentResponse })
  create(@Body() body: unknown): Promise<StudentSummary> {
    const parsed = CreateStudentBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const input = {
      name: parsed.data.name,
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    };
    return this.students.create(input);
  }

  @Get()
  @ApiOkResponse({ type: StudentResponse, isArray: true })
  list(): Promise<StudentSummary[]> {
    return this.students.list();
  }

  @Patch(':id')
  @ApiBody({ type: UpdateStudentBody })
  @ApiOkResponse({ type: StudentResponse })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<StudentSummary> {
    const parsed = UpdateStudentBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const input = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    };
    return this.students.update(id, input);
  }
}
