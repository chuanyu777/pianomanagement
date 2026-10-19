import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { businessMonthStart } from '../../common/time/business-calendar.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type DatabaseClient = Prisma.TransactionClient | PrismaService;

export type ClosedPeriodSummary = {
  periodStart: Date;
  closedAt: Date;
  reopenedAt: Date | null;
  reopenReason: string | null;
};

@Injectable()
export class PeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  async assertWritableForDate(occurredAt: Date, client: DatabaseClient = this.prisma): Promise<void> {
    const periodStart = businessMonthStart(occurredAt);
    const closed = await client.closedPeriod.findFirst({
      where: { periodStart, reopenedAt: null },
      select: { id: true },
    });
    if (closed) throw new ConflictException('该业务月份已关账，不能修改资金或课消记录');
  }

  async close(periodStart: Date, actorId: string): Promise<ClosedPeriodSummary> {
    try {
      const closed = await this.prisma.closedPeriod.create({
        data: { periodStart, closedById: actorId },
        select: { periodStart: true, closedAt: true, reopenedAt: true, reopenReason: true },
      });
      return closed;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该月份已经关账');
      }
      throw error;
    }
  }

  async reopen(periodStart: Date, reason: string, actorId: string): Promise<ClosedPeriodSummary> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.closedPeriod.findUnique({
        where: { periodStart },
        select: { id: true, reopenedAt: true },
      });
      if (!target) throw new NotFoundException('该月份尚未关账');
      if (target.reopenedAt) throw new ConflictException('该月份已经重新打开');
      const latest = await tx.closedPeriod.findFirst({
        where: { reopenedAt: null },
        orderBy: { closedAt: 'desc' },
        select: { id: true },
      });
      if (latest?.id !== target.id) throw new ConflictException('只能重新打开最近一次关账的月份');
      return tx.closedPeriod.update({
        where: { id: target.id },
        data: { reopenedAt: new Date(), reopenedById: actorId, reopenReason: reason.trim() },
        select: { periodStart: true, closedAt: true, reopenedAt: true, reopenReason: true },
      });
    });
  }

  list(): Promise<ClosedPeriodSummary[]> {
    return this.prisma.closedPeriod.findMany({
      select: { periodStart: true, closedAt: true, reopenedAt: true, reopenReason: true },
      orderBy: { periodStart: 'desc' },
    });
  }
}
