import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidPeriod, toPeriod, type Period } from '../../common/period.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** 只需要这一个 model，事务客户端也满足。 */
export type ClosedPeriodPrisma = Pick<PrismaService, 'closedPeriod'>;

/**
 * 关账（US-PC-01 / US-PC-02）。
 *
 * 关账**不是结算** —— 它不产生任何金额，只是禁止再改动该月数据。
 * 所以它是所有「写台账 / 写收支 / 写工资」入口的前置检查，
 * 漏挂一个入口，那个入口就能绕过锁，而且不会报错。
 */
@Injectable()
export class PeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  listClosedPeriods() {
    return this.prisma.closedPeriod.findMany({ orderBy: { period: 'desc' } });
  }

  async isClosed(period: Period, client: ClosedPeriodPrisma = this.prisma): Promise<boolean> {
    const found = await client.closedPeriod.findUnique({ where: { period } });
    return found !== null;
  }

  /** 写任何属于该月的数据之前都要过这一关。 */
  async assertOpen(period: Period, client: ClosedPeriodPrisma = this.prisma): Promise<void> {
    if (await this.isClosed(period, client)) {
      throw new ConflictException(`月份 ${period} 已关账，不能再新增 / 修改 / 删除该月数据`);
    }
  }

  /** 按时间点判断归属月份再校验。 */
  async assertOpenForDate(date: Date, client: ClosedPeriodPrisma = this.prisma): Promise<void> {
    await this.assertOpen(toPeriod(date), client);
  }

  async close(period: Period, closedById: string | null) {
    if (!isValidPeriod(period)) throw new ConflictException(`非法月份 ${period}，应形如 2026-10`);
    if (await this.isClosed(period)) throw new ConflictException(`月份 ${period} 已经关账了`);

    return this.prisma.closedPeriod.create({
      data: { period, closedAt: new Date(), closedById },
    });
  }

  /** 反关账。调用方必须已经限定为店主。 */
  async reopen(period: Period) {
    const found = await this.prisma.closedPeriod.findUnique({ where: { period } });
    if (!found) throw new NotFoundException(`月份 ${period} 没有关账，无需反关账`);
    await this.prisma.closedPeriod.delete({ where: { period } });
    return { period, reopened: true };
  }
}
