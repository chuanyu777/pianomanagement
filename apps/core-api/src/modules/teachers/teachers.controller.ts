import { BadRequestException, Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { TeachersService, type TeacherSummary } from './teachers.service.js';

class CreateTeacherBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  username!: string;

  @ApiProperty({ type: String, minLength: 12, maxLength: 128, format: 'password' })
  password!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  name!: string;
}

class UpdateTeacherCompensationBody {
  @ApiProperty({ type: String, example: '3000.00' }) defaultBaseSalary!: string;
  @ApiProperty({ type: String, example: '10.0000' }) defaultCommissionRate!: string;
}

class TeacherResponse implements TeacherSummary {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String })
  username!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;
  @ApiProperty({ type: String, example: '3000.00' }) defaultBaseSalary!: string;
  @ApiProperty({ type: String, example: '10.0000' }) defaultCommissionRate!: string;
}

const CreateTeacherBodySchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(128),
  name: z.string().trim().min(1).max(120),
}).strict();
const UpdateCompensationSchema = z.object({
  defaultBaseSalary: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/).transform((value) => new Prisma.Decimal(value)),
  defaultCommissionRate: z.string().regex(/^(?:0|[1-9]\d{0,2})\.\d{4}$/).transform((value) => new Prisma.Decimal(value)),
}).strict();

@ApiTags('Teachers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Post()
  @ApiBody({ type: CreateTeacherBody })
  @ApiCreatedResponse({ type: TeacherResponse })
  create(@Body() body: unknown): Promise<TeacherSummary> {
    const parsed = CreateTeacherBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.teachers.create(parsed.data);
  }

  @Get()
  @ApiOkResponse({ type: TeacherResponse, isArray: true })
  list(): Promise<TeacherSummary[]> {
    return this.teachers.list();
  }

  @Patch(':id/compensation')
  @ApiBody({ type: UpdateTeacherCompensationBody })
  @ApiOkResponse({ type: TeacherResponse })
  updateCompensation(@Param('id') id: string, @Body() body: unknown): Promise<TeacherSummary> {
    if (!z.string().uuid().safeParse(id).success) throw new BadRequestException('请求参数不合法');
    const parsed = UpdateCompensationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.teachers.updateCompensation(id, parsed.data);
  }
}
