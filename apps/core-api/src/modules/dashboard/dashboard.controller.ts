import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DashboardService } from './dashboard.service.js';

class DashboardNamedEntity { @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String }) name!: string; }
class DashboardLesson { @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String, format: 'date-time' }) startsAt!: string; @ApiProperty({ type: String, format: 'date-time' }) endsAt!: string; @ApiProperty({ type: String }) status!: string; @ApiProperty({ type: DashboardNamedEntity }) student!: DashboardNamedEntity; @ApiProperty({ type: DashboardNamedEntity }) course!: DashboardNamedEntity; }
class DashboardToday { @ApiProperty({ type: Number }) total!: number; @ApiProperty({ type: Number }) pendingCount!: number; @ApiProperty({ type: Number }) completedCount!: number; @ApiProperty({ type: DashboardLesson, isArray: true }) lessons!: DashboardLesson[]; }
class DashboardStudents { @ApiProperty({ type: Number }) total!: number; @ApiProperty({ type: Number }) frozenCount!: number; @ApiProperty({ type: Number }) arrearsCount!: number; }
class DashboardFinance { @ApiProperty({ type: String }) period!: string; @ApiProperty({ type: String }) operatingProfit!: string; @ApiProperty({ type: String }) cashNet!: string; }
class DashboardBlocker { @ApiProperty({ type: String }) code!: string; @ApiProperty({ type: Number }) count!: number; @ApiProperty({ type: String }) message!: string; }
class DashboardPreclose { @ApiProperty({ type: String }) period!: string; @ApiProperty({ type: Boolean }) closed!: boolean; @ApiProperty({ type: Number }) unpaidPayrollCount!: number; @ApiProperty({ type: DashboardBlocker, isArray: true }) blockers!: DashboardBlocker[]; }
class DashboardRecentRecord { @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ type: String }) kind!: string; @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string; @ApiProperty({ type: String }) studentName!: string; @ApiProperty({ type: String }) courseName!: string; @ApiProperty({ type: String }) paidDelta!: string; @ApiProperty({ type: String }) giftDelta!: string; }
class DashboardOverview { @ApiProperty({ type: String, format: 'date-time' }) asOf!: string; @ApiProperty({ type: String, format: 'date' }) businessDate!: string; @ApiProperty({ type: DashboardToday }) today!: DashboardToday; @ApiProperty({ type: DashboardStudents, nullable: true }) students!: DashboardStudents | null; @ApiProperty({ type: DashboardFinance, nullable: true }) finance!: DashboardFinance | null; @ApiProperty({ type: DashboardPreclose, nullable: true }) preclose!: DashboardPreclose | null; @ApiProperty({ type: DashboardRecentRecord, isArray: true, nullable: true }) recentRecords!: DashboardRecentRecord[] | null; }

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.TEACHER)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  @ApiOkResponse({ type: DashboardOverview, description: 'Current actor-scoped operating overview' })
  overview(@Req() request: AuthenticatedRequest) {
    return this.dashboard.overview(request.actor!);
  }
}
