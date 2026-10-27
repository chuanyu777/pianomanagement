import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  async ownerFacts() {
    const [accounts, recent] = await Promise.all([
      this.prisma.studentCourseAccount.findMany({
        where: { student: { withdrawnAt: null } },
        select: { studentId: true, openingPaidBalance: true, ledgerEntries: { select: { paidDelta: true } } },
      }),
      this.prisma.ledgerEntry.findMany({
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 5,
        select: { id: true, kind: true, occurredAt: true, paidDelta: true, giftDelta: true, account: { select: { student: { select: { name: true } }, course: { select: { name: true } } } } },
      }),
    ]);
    const arrears = new Set<string>();
    for (const account of accounts) {
      const balance = account.ledgerEntries.reduce((sum, entry) => sum.add(entry.paidDelta), new Prisma.Decimal(account.openingPaidBalance));
      if (balance.isNegative()) arrears.add(account.studentId);
    }
    return {
      arrearsCount: arrears.size,
      recentRecords: recent.map((entry) => ({
        id: entry.id, kind: entry.kind, occurredAt: entry.occurredAt.toISOString(), studentName: entry.account.student.name,
        courseName: entry.account.course.name, paidDelta: entry.paidDelta.toFixed(2), giftDelta: entry.giftDelta.toFixed(2),
      })),
    };
  }
}
