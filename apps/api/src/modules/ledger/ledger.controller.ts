import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { ByTeacherQueryDto } from './dto/by-teacher-query.dto.js';
import { ListEntriesQueryDto } from './dto/list-entries.dto.js';
import { StudentLedgerQueryDto } from './dto/student-ledger-query.dto.js';
import { LedgerService } from './ledger.service.js';

/**
 * 学生余额与课时台账（US-ML-01）。整块只对店主开放（权限矩阵 §8）。
 *
 * controller 只做参数绑定与转发，所有业务判断在 service。
 */
@Controller('ledger')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('students/:studentId')
  getStudentLedger(
    @Param('studentId') studentId: string,
    @Query() query: StudentLedgerQueryDto,
  ) {
    return this.ledger.getStudentLedger(studentId, query.period);
  }

  @Get('entries')
  listEntries(@Query() query: ListEntriesQueryDto) {
    return this.ledger.listEntries(query);
  }

  /** 按老师分组查看。静态路由放在带参路由之后，避免被 :studentId 误吞。 */
  @Get('by-teacher')
  listByTeacher(@Query() query: ByTeacherQueryDto) {
    return this.ledger.listByTeacher(query.period);
  }
}
