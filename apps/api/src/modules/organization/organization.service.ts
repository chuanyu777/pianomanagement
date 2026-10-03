import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ratiosSumToOne } from '../../common/money.js';

/**
 * 机构设置（US-BD-07）。**单例表** —— 全项目只有一行，
 * 靠 `singleton` 字段的唯一约束从结构上保证，不靠约定。
 *
 * 其它模块只读这里（课消奖默认比例、退费费率、扣池顺序、接续数据），
 * 不要自己去查 organization 表。
 */
@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  /** 取机构设置；还没有就按默认值建一条。 */
  async get() {
    return this.prisma.organization.upsert({
      where: { singleton: true },
      update: {},
      create: { singleton: true, name: '未命名琴行' },
    });
  }

  async update(data: Prisma.OrganizationUpdateInput) {
    await this.get();
    return this.prisma.organization.update({ where: { singleton: true }, data });
  }

  /** 接续数据是否已录全（US-IW-02）。没录全就允许继续用，但首月报表会不准。 */
  async isOnboardingCompleted(): Promise<boolean> {
    const org = await this.get();
    return org.onboardingCompletedAt !== null;
  }

  async markOnboardingCompleted() {
    await this.get();
    return this.prisma.organization.update({
      where: { singleton: true },
      data: { onboardingCompletedAt: new Date() },
    });
  }

  listProfitShares() {
    return this.prisma.profitShareRule.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * 整体替换利润分配规则。**比例合计必须恰好等于 1** ——
   * 不等于 1 会让利润分配「分不完」或「分超」，而且两项都不会报错。
   */
  async replaceProfitShares(rules: { name: string; ratio: Prisma.Decimal | string | number }[]) {
    if (rules.length === 0) {
      throw new BadRequestException('利润分配至少要有一个分配人');
    }
    if (!ratiosSumToOne(rules.map((rule) => rule.ratio))) {
      const total = rules.reduce((acc, rule) => acc.plus(rule.ratio), new Prisma.Decimal(0));
      throw new BadRequestException(`利润分配比例合计必须等于 100%，当前是 ${total.times(100).toFixed(2)}%`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.profitShareRule.updateMany({ where: {}, data: { isActive: false } });
      await Promise.all(
        rules.map((rule, index) =>
          tx.profitShareRule.create({
            data: {
              name: rule.name,
              ratio: new Prisma.Decimal(rule.ratio),
              sortOrder: index,
            },
          }),
        ),
      );
      return tx.profitShareRule.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      });
    });
  }
}
