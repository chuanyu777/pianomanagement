import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { StudentsService, type StudentSummary } from './students.service.js';

class CreateStudentBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  name!: string;

  @ApiPropertyOptional({ type: String, minLength: 6, maxLength: 24, nullable: true })
  phone?: string | null;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 2000, nullable: true })
  notes?: string | null;
}

class UpdateStudentBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120, required: false })
  name?: string;

  @ApiPropertyOptional({ type: String, minLength: 6, maxLength: 24, nullable: true })
  phone?: string | null;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 2000, nullable: true })
  notes?: string | null;
}

class StudentResponse implements StudentSummary {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: ['STUDYING', 'FROZEN', 'WITHDRAWN'] })
  enrollmentStatus!: 'STUDYING' | 'FROZEN' | 'WITHDRAWN';

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

class StudentPageResponse {
  @ApiProperty({ type: StudentResponse, isArray: true }) items!: StudentResponse[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number, nullable: true, description: '定位目标不存在或不符合筛选时为 null' }) page!: number | null;
  @ApiProperty({ type: Number }) pageSize!: number;
}

const pageInteger = (max: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max));
const StudentPageQuery = z.object({
  q: z.string().trim().max(120).optional(),
  page: pageInteger(1000000).optional().default(1),
  pageSize: pageInteger(100).optional().default(8),
  enrollmentStatus: z.enum(['STUDYING', 'FROZEN', 'WITHDRAWN']).optional(),
  arrears: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  locateStudentId: z.uuid().optional(),
}).strict();

const NotesSchema = z.string().trim().min(1).max(2000).nullable().optional();

const CreateStudentBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(24).nullable().optional(),
  notes: NotesSchema,
}).strict();

const UpdateStudentBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(24).nullable().optional(),
  notes: NotesSchema,
}).strict().refine((body) => body.name !== undefined || body.phone !== undefined || body.notes !== undefined);

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
      ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    };
    return this.students.create(input);
  }

  @Get()
  @ApiOkResponse({ type: StudentResponse, isArray: true })
  @ApiQuery({ name: 'q', required: false, type: String, description: '按学生姓名或联系电话搜索' })
  list(@Query() query: unknown): Promise<StudentSummary[]> {
    const parsed = z.object({ q: z.string().trim().max(120).optional() }).strict().safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.students.list(parsed.data.q);
  }

  @Get('page')
  @ApiOkResponse({ type: StudentPageResponse })
  @ApiQuery({ name: 'q', required: false, type: String, description: '按姓名或联系电话搜索' })
  @ApiQuery({ name: 'page', required: false, type: Number, minimum: 1, maximum: 1000000, description: '页码，从 1 开始，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, minimum: 1, maximum: 100, description: '每页条数，默认 8' })
  @ApiQuery({ name: 'enrollmentStatus', required: false, enum: ['STUDYING', 'FROZEN', 'WITHDRAWN'] })
  @ApiQuery({ name: 'arrears', required: false, type: Boolean, description: 'true 仅欠费；false 仅非欠费（含退学生）' })
  @ApiQuery({ name: 'locateStudentId', required: false, type: String, format: 'uuid', description: '定位筛选结果中该学生所在页；未命中返回 page=null' })
  listPage(@Query() query: unknown) {
    const parsed = StudentPageQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.students.listPage(parsed.data);
  }

  @Get(':id')
  @ApiOkResponse({ type: StudentResponse })
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<StudentSummary> {
    return this.students.get(id);
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
      ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    };
    return this.students.update(id, input);
  }
}
