import { BadRequestException, Injectable } from '@nestjs/common';
import { money, ZERO } from '../../common/money.js';
import { Prisma } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import { OrganizationService } from '../organization/organization.service.js';
import { CarryOverDto, CarryOverStudentDto } from './dto/carry-over.dto.js';

/**
 * `Organization.get()` 尚未填写机构名时使用的默认值（见 organization.service.ts）。
 * 机构信息步判定「已填」= 名字不是这个占位值。
 */
const DEFAULT_ORGANIZATION_NAME = '未命名琴行';

export type OnboardingStepKey =
  | 'organization'
  | 'courseTypes'
  | 'people'
  | 'students'
  | 'cash'
  | 'previousProfit'
  | 'previousPayroll'
  | 'items';

export type OnboardingStep = {
  key: OnboardingStepKey;
  label: string;
  done: boolean;
};

export type OnboardingStatus = {
  completed: boolean;
  completedAt: string | null;
  steps: OnboardingStep[];
};

/** 8 步顺序与展示名（对应 US-IW-01 的 ①~⑧）。 */
const STEP_DEFS: readonly { key: OnboardingStepKey; label: string }[] = [
  { key: 'organization', label: '机构信息' },
  { key: 'courseTypes', label: '课程类型' },
  { key: 'people', label: '人员与账号' },
  { key: 'students', label: '学生与报名' },
  { key: 'cash', label: '现金结余期初' },
  { key: 'previousProfit', label: '上月盈利' },
  { key: 'previousPayroll', label: '上月应发工资' },
  { key: 'items', label: '收支项目' },
];

/** complete 必须全部满足的步骤（第 8 步由 seed 保证，不在此列）。 */
const REQUIRED_STEPS: readonly OnboardingStepKey[] = [
  'organization',
  'courseTypes',
  'people',
  'students',
  'cash',
  'previousProfit',
  'previousPayroll',
];

/**
 * 缺了这几步首月报表就会错（US-IW-02）：现金期初影响结余，
 * 上月盈利影响利润分配，上月应发工资影响首月工资现金支出。
 */
const FINANCE_CRITICAL_STEPS: readonly OnboardingStepKey[] = [
  'cash',
  'previousProfit',
  'previousPayroll',
];

/**
 * 初始化向导（US-IW-01 / US-IW-02）。
 *
 * ── 关于第 6 / 7 步「是否已录入」为什么这么判 ──────────────────────────────
 * `Organization.previousMonthProfit` / `previousMonthPayroll` 的默认值都是 0，
 * 数据库层面**无法区分「没录」和「录了 0」**；而需求明确「0 也是合法录入值」，
 * 所以绝不能拿 `> 0` 当「已录入」（那样录了 0 的用户会被永远挡在向导里）。
 * 又因为不能改 schema 加「是否录入」字段，这里用两个可判定的信号合并：
 *   1. `Organization.onboardingCompletedAt`（持久）—— 一旦向导完成，说明当时这些值已校验过，
 *      这两个步骤一律视为已完成；
 *   2. `submittedFinancialSteps`（**本次进程会话内**）—— `PUT /onboarding/carry-over`
 *      本次请求里显式带了哪个字段，就记住哪个字段「提交过」。字段值哪怕是 0 也算提交过。
 * 代价：若服务在「提交了但还没 complete」之间重启，会话内标记会丢、向导会要求重录一次；
 * 这只是多填一次，**不会**把「没录」当成「录了 0」，也不会让首月报表算错。
 */
@Injectable()
export class OnboardingService {
  /** 本次会话内已显式提交过的资金类步骤（值可为 0）。 */
  private readonly submittedFinancialSteps = new Set<OnboardingStepKey>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly organization: OrganizationService,
    private readonly items: ItemsService,
  ) {}

  async getStatus(): Promise<OnboardingStatus> {
    const org = await this.organization.get();
    const completed = org.onboardingCompletedAt !== null;
    return {
      completed,
      completedAt: org.onboardingCompletedAt?.toISOString() ?? null,
      steps: await this.collectSteps(org, completed),
    };
  }

  /**
   * IW-02：录入首月接续数据。
   *
   * 校验（学生存在、报名关系归属该学生、单价 > 0）**全部在写之前完成**，
   * 任一不合法就 400，一条数据都不写。
   */
  async carryOver(dto: CarryOverDto): Promise<OnboardingStatus> {
    const students = dto.students ?? [];
    await this.assertTargets(students);

    const orgData: Prisma.OrganizationUpdateInput = {};
    if (dto.initialCashBalance !== undefined) {
      orgData.initialCashBalance = money(dto.initialCashBalance);
    }
    if (dto.previousMonthProfit !== undefined) {
      orgData.previousMonthProfit = money(dto.previousMonthProfit);
    }
    if (dto.previousMonthPayroll !== undefined) {
      orgData.previousMonthPayroll = money(dto.previousMonthPayroll);
    }
    if (Object.keys(orgData).length > 0) {
      // 机构三个值走项目约定的机构写入口。
      // 注意：OrganizationService.update 内部用基础 Prisma 客户端、不接受 tx，
      // 因此它与下面报名写入**不是严格同一事务**（见报告「发现的模型问题」）。
      // 好在所有校验都在写之前，校验失败时这里根本不会被调用。
      await this.organization.update(orgData);
      if (dto.initialCashBalance !== undefined) this.submittedFinancialSteps.add('cash');
      if (dto.previousMonthProfit !== undefined) this.submittedFinancialSteps.add('previousProfit');
      if (dto.previousMonthPayroll !== undefined) this.submittedFinancialSteps.add('previousPayroll');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const student of students) {
        for (const enrollment of student.enrollments) {
          await tx.enrollment.update({
            where: { id: enrollment.enrollmentId },
            data: {
              initialPaidBalance: money(enrollment.initialPaidBalance),
              initialGiftBalance: money(enrollment.initialGiftBalance),
              unitPrice: money(enrollment.unitPrice),
            },
          });
        }
      }
    });

    return this.getStatus();
  }

  /**
   * IW-01 complete：灌默认收支项目模板 → 校验必要项 → 打上完成标记。
   * 缺现金期初 / 上月盈利 / 上月应发工资时 400 并提示「首月报表将不正确」，不允许跳过。
   */
  async complete(): Promise<OnboardingStatus> {
    // 第 8 步（收支项目清单）由系统灌默认模板保证，幂等。
    await this.items.seedDefaults();

    const org = await this.organization.get();
    const completedBefore = org.onboardingCompletedAt !== null;
    const steps = await this.collectSteps(org, completedBefore);
    const done = new Map(steps.map((step) => [step.key, step.done]));

    const missing = REQUIRED_STEPS.filter((key) => !done.get(key));
    if (missing.length > 0) {
      const labels = missing.map((key) => this.labelOf(key)).join('、');
      const financeCritical = missing.some((key) => FINANCE_CRITICAL_STEPS.includes(key));
      throw new BadRequestException(
        financeCritical
          ? `初始化未完成，缺少：${labels}。首月报表将不正确（首月利润分配与工资现金支出会变成 0），请补录后再完成。`
          : `初始化未完成，缺少：${labels}`,
      );
    }

    const updated = await this.organization.markOnboardingCompleted();
    return {
      completed: true,
      completedAt: updated.onboardingCompletedAt?.toISOString() ?? null,
      steps: await this.collectSteps(updated, true),
    };
  }

  // ── 内部工具 ────────────────────────────────────────────────────────

  private async collectSteps(
    org: { name: string; city: string | null; reporter: string | null; initialCashBalance: Prisma.Decimal },
    completed: boolean,
  ): Promise<OnboardingStep[]> {
    const [courseTypes, teachers, users, students, enrollments, incomeItems, expenseItems] =
      await Promise.all([
        this.prisma.courseType.count(),
        this.prisma.teacher.count(),
        this.prisma.user.count(),
        this.prisma.student.count(),
        this.prisma.enrollment.count(),
        this.prisma.incomeItem.count(),
        this.prisma.expenseItem.count(),
      ]);

    const done: Record<OnboardingStepKey, boolean> = {
      organization: this.isOrganizationFilled(org),
      courseTypes: courseTypes > 0,
      people: teachers > 0 && users > 0,
      students: students > 0 && enrollments > 0,
      cash: money(org.initialCashBalance).greaterThan(ZERO),
      // 只用「持久完成标记」或「本次会话提交过」，绝不用 > 0（0 是合法录入值）。
      previousProfit: completed || this.submittedFinancialSteps.has('previousProfit'),
      previousPayroll: completed || this.submittedFinancialSteps.has('previousPayroll'),
      items: incomeItems > 0 && expenseItems > 0,
    };

    return STEP_DEFS.map((def) => ({ key: def.key, label: def.label, done: done[def.key] }));
  }

  private isOrganizationFilled(org: {
    name: string;
    city: string | null;
    reporter: string | null;
  }): boolean {
    return (
      org.name.trim().length > 0 &&
      org.name !== DEFAULT_ORGANIZATION_NAME &&
      Boolean(org.city && org.city.trim().length > 0) &&
      Boolean(org.reporter && org.reporter.trim().length > 0)
    );
  }

  private async assertTargets(students: readonly CarryOverStudentDto[]): Promise<void> {
    if (students.length === 0) return;

    for (const student of students) {
      for (const enrollment of student.enrollments) {
        if (money(enrollment.unitPrice).lessThanOrEqualTo(ZERO)) {
          throw new BadRequestException('课程单价必须大于 0：单价为 0 时「预计剩余课时」会除零');
        }
      }
    }

    const studentIds = [...new Set(students.map((student) => student.studentId))];
    const enrollmentIds = students.flatMap((student) =>
      student.enrollments.map((enrollment) => enrollment.enrollmentId),
    );
    if (new Set(enrollmentIds).size !== enrollmentIds.length) {
      throw new BadRequestException('同一报名关系不能出现在多个学生下');
    }

    const [foundStudents, foundEnrollments] = await Promise.all([
      this.prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true },
      }),
      this.prisma.enrollment.findMany({
        where: { id: { in: enrollmentIds } },
        select: { id: true, studentId: true },
      }),
    ]);
    if (foundStudents.length !== studentIds.length) {
      throw new BadRequestException('接续数据引用的学生不存在');
    }

    const ownerById = new Map(foundEnrollments.map((row) => [row.id, row.studentId]));
    for (const student of students) {
      for (const enrollment of student.enrollments) {
        const owner = ownerById.get(enrollment.enrollmentId);
        if (owner === undefined) {
          throw new BadRequestException(`报名关系不存在：${enrollment.enrollmentId}`);
        }
        if (owner !== student.studentId) {
          throw new BadRequestException(
            `报名关系 ${enrollment.enrollmentId} 不属于学生 ${student.studentId}`,
          );
        }
      }
    }
  }

  private labelOf(key: OnboardingStepKey): string {
    return STEP_DEFS.find((def) => def.key === key)?.label ?? key;
  }
}
