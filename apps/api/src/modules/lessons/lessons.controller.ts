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
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateLessonDto } from './dto/create-lesson.dto.js';
import { ListLessonsQueryDto } from './dto/list-lessons.dto.js';
import { ListPendingQueryDto } from './dto/list-pending.dto.js';
import { UpdateLessonDto } from './dto/update-lesson.dto.js';
import { LessonsService } from './lessons.service.js';

/**
 * 排课与上课确认。
 *
 * 权限两档（§8 权限矩阵）：
 * - 排课增删改查：仅 OWNER。
 * - 待确认列表 / 确认 / 请假 / 取消：OWNER 与 TEACHER 都可，但 TEACHER 的
 *   「只能自己的课」是**行级约束**，在 service 里判（不能只靠这里的 @Roles）。
 */
@Controller('lessons')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}

  @Get()
  @Roles(UserRole.OWNER)
  list(@Query() query: ListLessonsQueryDto) {
    return this.lessons.list(query);
  }

  // 必须排在 :id 之前，否则 pending 会被当成 id 匹配掉。
  @Get('pending')
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  listPending(@Query() query: ListPendingQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.lessons.listPending(actor, query.teacherId);
  }

  @Get(':id')
  @Roles(UserRole.OWNER)
  getById(@Param('id') id: string) {
    return this.lessons.getById(id);
  }

  @Post()
  @Roles(UserRole.OWNER)
  create(@Body() dto: CreateLessonDto) {
    return this.lessons.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER)
  update(@Param('id') id: string, @Body() dto: UpdateLessonDto) {
    return this.lessons.update(id, dto);
  }

  @Post(':id/confirm')
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  confirm(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.lessons.confirm(id, actor);
  }

  @Post(':id/leave')
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  markLeave(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.lessons.markLeave(id, actor);
  }

  @Post(':id/cancel')
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  cancel(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.lessons.cancel(id, actor);
  }

  /** 排课删除 = 取消（曾确认过则自动回冲）。仅店主。 */
  @Delete(':id')
  @Roles(UserRole.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    await this.lessons.cancel(id, actor);
  }
}
