import { BadRequestException, Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { TeachersService, type TeacherSummary } from './teachers.service.js';

class CreateTeacherBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 80, required: false })
  username?: string;

  @ApiProperty({ type: String, minLength: 12, maxLength: 128, format: 'password', required: false })
  password?: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ type: String, example: '3000.00', required: false })
  defaultBaseSalary?: string;

  @ApiProperty({ type: String, example: '10.0000', required: false })
  defaultCommissionRate?: string;
}

class UpdateTeacherCompensationBody {
  @ApiProperty({ type: String, example: '3000.00' }) defaultBaseSalary!: string;
  @ApiProperty({ type: String, example: '10.0000' }) defaultCommissionRate!: string;
}

class OpenTeacherLoginAccountBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 80 }) username!: string;
  @ApiProperty({ type: String, minLength: 12, maxLength: 128, format: 'password' }) password!: string;
}

class TeacherResponse implements TeacherSummary {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  userId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  username!: string | null;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;
  @ApiProperty({ type: String, example: '3000.00' }) defaultBaseSalary!: string;
  @ApiProperty({ type: String, example: '10.0000' }) defaultCommissionRate!: string;
}

const CreateTeacherBodySchema = z.object({
  username: z.string().trim().min(1).max(80).optional(),
  password: z.string().min(12).max(128).optional(),
  name: z.string().trim().min(1).max(120),
  defaultBaseSalary: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/).transform((value) => new Prisma.Decimal(value)).optional(),
  defaultCommissionRate: z.string().regex(/^(?:0|[1-9]\d{0,2})\.\d{4}$/).transform((value) => new Prisma.Decimal(value)).optional(),
}).strict().superRefine((value, context) => {
  if ((value.username === undefined) !== (value.password === undefined)) {
    context.addIssue({ code: 'custom', message: '用户名和密码必须同时提供' });
  }
});
const UpdateCompensationSchema = z.object({
  defaultBaseSalary: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/).transform((value) => new Prisma.Decimal(value)),
  defaultCommissionRate: z.string().regex(/^(?:0|[1-9]\d{0,2})\.\d{4}$/).transform((value) => new Prisma.Decimal(value)),
}).strict();
const OpenLoginAccountSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(128),
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
    return this.teachers.create({
      name: parsed.data.name,
      ...(parsed.data.username === undefined ? {} : { username: parsed.data.username }),
      ...(parsed.data.password === undefined ? {} : { password: parsed.data.password }),
      defaultBaseSalary: parsed.data.defaultBaseSalary ?? new Prisma.Decimal('0.00'),
      defaultCommissionRate: parsed.data.defaultCommissionRate ?? new Prisma.Decimal('0.0000'),
    });
  }

  @Get()
  @ApiOkResponse({ type: TeacherResponse, isArray: true })
  list(): Promise<TeacherSummary[]> {
    return this.teachers.list();
  }

  @Post(':id/login-account')
  @ApiBody({ type: OpenTeacherLoginAccountBody })
  @ApiCreatedResponse({ type: TeacherResponse })
  openLoginAccount(@Param('id') id: string, @Body() body: unknown): Promise<TeacherSummary> {
    if (!z.string().uuid().safeParse(id).success) throw new BadRequestException('请求参数不合法');
    const parsed = OpenLoginAccountSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.teachers.openLoginAccount(id, parsed.data);
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
