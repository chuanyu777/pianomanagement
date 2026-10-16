import { BadRequestException, Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CoursesService, type CourseSummary, type UpdateCourseInput } from './courses.service.js';

const MAX_COURSE_PRICE = new Prisma.Decimal('999999999999.99');
const priceSchema = z.string()
  .regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/)
  .transform((value) => new Prisma.Decimal(value))
  .refine((value) => value.lte(MAX_COURSE_PRICE));

class CreateCourseBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ type: String, pattern: '^\\d+\\.\\d{2}$', example: '380.00' })
  defaultUnitPrice!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 480 })
  defaultDurationMinutes!: number;
}

class UpdateCourseBody {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120, required: false })
  name?: string;

  @ApiProperty({ type: String, pattern: '^\\d+\\.\\d{2}$', example: '380.00', required: false })
  defaultUnitPrice?: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 480, required: false })
  defaultDurationMinutes?: number;

  @ApiProperty({ type: Boolean, required: false })
  isActive?: boolean;
}

class CourseResponse implements CourseSummary {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String, pattern: '^\\d+\\.\\d{2}$', example: '380.00' })
  defaultUnitPrice!: string;

  @ApiProperty({ type: Number })
  defaultDurationMinutes!: number;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;
}

const CreateCourseBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  defaultUnitPrice: priceSchema,
  defaultDurationMinutes: z.number().int().min(1).max(480),
}).strict();

const UpdateCourseBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  defaultUnitPrice: priceSchema.optional(),
  defaultDurationMinutes: z.number().int().min(1).max(480).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

const CourseIdSchema = z.string().uuid();

@ApiTags('Courses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Post()
  @ApiBody({ type: CreateCourseBody })
  @ApiCreatedResponse({ type: CourseResponse })
  create(@Body() body: unknown): Promise<CourseSummary> {
    const parsed = CreateCourseBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.courses.create(parsed.data);
  }

  @Get()
  @ApiOkResponse({ type: CourseResponse, isArray: true })
  list(): Promise<CourseSummary[]> {
    return this.courses.list();
  }

  @Patch(':id')
  @ApiBody({ type: UpdateCourseBody })
  @ApiOkResponse({ type: CourseResponse })
  update(@Param('id') id: unknown, @Body() body: unknown): Promise<CourseSummary> {
    const parsedId = CourseIdSchema.safeParse(id);
    const parsedBody = UpdateCourseBodySchema.safeParse(body);
    if (!parsedId.success || !parsedBody.success) {
      throw new BadRequestException('请求参数不合法');
    }
    const update: UpdateCourseInput = {};
    if (parsedBody.data.name !== undefined) update.name = parsedBody.data.name;
    if (parsedBody.data.defaultUnitPrice !== undefined) {
      update.defaultUnitPrice = parsedBody.data.defaultUnitPrice;
    }
    if (parsedBody.data.defaultDurationMinutes !== undefined) {
      update.defaultDurationMinutes = parsedBody.data.defaultDurationMinutes;
    }
    if (parsedBody.data.isActive !== undefined) update.isActive = parsedBody.data.isActive;
    return this.courses.update(parsedId.data, update);
  }
}
