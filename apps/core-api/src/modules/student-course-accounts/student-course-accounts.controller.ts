import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  StudentCourseAccountsService,
  type StudentCourseAccountSummary,
} from './student-course-accounts.service.js';

const MONEY_STRING = /^(?:0|[1-9]\d{0,11})\.\d{2}$/;

class CreateStudentCourseAccountBody {
  @ApiProperty({ type: String, format: 'uuid' })
  courseId!: string;

  @ApiProperty({ type: String, pattern: MONEY_STRING.source, required: false, example: '180.00' })
  currentUnitPrice?: string;
}

class UpdateStudentCourseAccountPriceBody {
  @ApiProperty({ type: String, pattern: MONEY_STRING.source, example: '200.00' })
  currentUnitPrice!: string;
}

class StudentCourseAccountResponse implements StudentCourseAccountSummary {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  studentId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  courseId!: string;

  @ApiProperty({ type: String })
  courseName!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  defaultDurationMinutes!: number;

  @ApiProperty({ type: String, example: '180.00' })
  currentUnitPrice!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  version!: number;
}

const StudentIdSchema = z.string().uuid();
const AccountIdSchema = z.string().uuid();
const MoneySchema = z.string().regex(MONEY_STRING).transform((value) => new Prisma.Decimal(value));
const CreateAccountBodySchema = z.object({
  courseId: z.string().uuid(),
  currentUnitPrice: MoneySchema.optional(),
}).strict();
const UpdateAccountPriceBodySchema = z.object({ currentUnitPrice: MoneySchema }).strict();

function parsePathId(value: string): string {
  const parsed = StudentIdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('请求参数不合法');
  return parsed.data;
}

@ApiTags('Student course accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
@Controller()
export class StudentCourseAccountsController {
  constructor(private readonly accounts: StudentCourseAccountsService) {}

  @Post('students/:studentId/course-accounts')
  @ApiBody({ type: CreateStudentCourseAccountBody })
  @ApiCreatedResponse({ type: StudentCourseAccountResponse })
  create(@Param('studentId') studentId: string, @Body() body: unknown): Promise<StudentCourseAccountSummary> {
    const parsedStudentId = parsePathId(studentId);
    const parsedBody = CreateAccountBodySchema.safeParse(body);
    if (!parsedBody.success) throw new BadRequestException('请求参数不合法');
    return this.accounts.create(parsedStudentId, parsedBody.data);
  }

  @Get('students/:studentId/course-accounts')
  @ApiOkResponse({ type: StudentCourseAccountResponse, isArray: true })
  list(@Param('studentId') studentId: string): Promise<StudentCourseAccountSummary[]> {
    return this.accounts.listForStudent(parsePathId(studentId));
  }

  @Patch('student-course-accounts/:accountId')
  @ApiBody({ type: UpdateStudentCourseAccountPriceBody })
  @ApiOkResponse({ type: StudentCourseAccountResponse })
  updatePrice(
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<StudentCourseAccountSummary> {
    const parsedAccountId = AccountIdSchema.safeParse(accountId);
    const parsedBody = UpdateAccountPriceBodySchema.safeParse(body);
    if (!parsedAccountId.success || !parsedBody.success) throw new BadRequestException('请求参数不合法');
    return this.accounts.updatePrice(parsedAccountId.data, parsedBody.data);
  }
}
