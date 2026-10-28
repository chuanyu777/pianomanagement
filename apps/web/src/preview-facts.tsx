import type { ReactNode } from 'react';

const LABELS: Record<string, string> = {
  name: '名称', nameBefore: '原名称', nameAfter: '新名称', title: '操作名称', summary: '操作摘要',
  student: '学生', studentName: '学生', teacher: '教师', teacherName: '教师', course: '课程', courseName: '课程',
  accountName: '课程账户', accountType: '账户类型', period: '业务月份', periodStart: '业务月份',
  amount: '金额', feeAmount: '手续费', feePercentage: '手续费比例', actualRefundAmount: '实际退款金额',
  totalPaidRefund: '累计实付退款', refundAmount: '退款金额', refundFeeIncome: '退费手续费收入',
  beforeBalance: '操作前余额', afterBalance: '操作后余额', paidBalance: '实付余额', giftBalance: '赠送余额', totalBalance: '账户总余额',
  paidBalanceBefore: '操作前实付余额', giftBalanceBefore: '操作前赠送余额', paidBalanceAfter: '操作后实付余额', giftBalanceAfter: '操作后赠送余额',
  paidRefundAmount: '实付退款金额', giftClearingAmount: '清零赠送金额', studentStatusBefore: '操作前学籍状态', studentStatusAfter: '操作后学籍状态', studentStatus: '学籍状态',
  beforeBaseSalary: '原基本工资', afterBaseSalary: '新基本工资', baseSalary: '基本工资', defaultBaseSalary: '默认基本工资',
  beforeCommissionRate: '原提成比例', afterCommissionRate: '新提成比例', commissionRate: '提成比例', defaultCommissionRate: '默认提成比例',
  commissionAmount: '课消提成', bonusAmount: '奖金', beforeBonusAmount: '原奖金', afterBonusAmount: '新奖金',
  deductionAmount: '代扣', beforeDeductionAmount: '原代扣', afterDeductionAmount: '新代扣', grossSalary: '应发工资', netSalary: '实发工资',
  courseRevenue: '课消收入', payrollCost: '工资成本', paidConsumed: '实付扣减', giftConsumed: '赠送扣减', paidRestore: '实付恢复', giftRestore: '赠送恢复',
  priceBefore: '原单价', priceAfter: '新单价', currentUnitPrice: '当前单价', defaultUnitPrice: '课程默认单价', unitPrice: '课程单价',
  defaultDurationMinutes: '默认课时', durationMinutes: '课时', lessonCount: '课程节数', count: '数量',
  channel: '收付款渠道', paymentChannel: '支付渠道', occurredAt: '业务发生时间', paidAt: '支付时间', createdAt: '创建时间', executedAt: '完成时间',
  startsAt: '开始时间', endsAt: '结束时间', previousStartsAt: '原上课时间', status: '状态', statusBefore: '操作前状态', statusAfter: '操作后状态',
  unitPriceSnapshot: '上课计费单价', correctedUnitPrice: '更正后单价',
  kind: '收支类型', type: '业务类型', category: '分类', incomeCategory: '收入分类', expenseCategory: '支出分类',
  note: '备注', reason: '原因', refundReason: '退款原因', transactionNote: '业务备注', phone: '联系电话', notes: '资料备注',
  createsLoginAccount: '是否创建登录账号', isActive: '启用状态', enabled: '启用状态',
  courses: '课程明细', details: '明细', items: '明细', refundDetails: '退款明细',
  action: '操作', riskLevel: '风险等级',
};

const HIDDEN_KEYS = new Set([
  'id', 'previewId', 'requestId', 'runId', 'threadId', 'actorUserId', 'userId', 'jti', 'nonce',
  'idempotencyKey', 'auditEventId', 'schemaVersion', 'resourceVersion', 'resourceVersions',
  'version', 'accountVersion', 'payrollVersion', 'resourceId', 'resourceType', 'eventId', 'operationId',
  'traceId', 'correlationId', 'createdBy', 'updatedBy', 'capability', 'permissions', 'authorization', 'token', 'actionType',
]);

const ENUMS: Record<string, string> = {
  CASH: '现金', BANK_TRANSFER: '银行转账', BANK_CARD: '银行卡', WECHAT: '微信', WECHAT_PAY: '微信支付', ALIPAY: '支付宝',
  OTHER: '其他', INCOME: '收入', EXPENSE: '支出', PAYMENT: '交费', GIFT: '赠送', REFUND: '退款',
  PAID: '已支付', UNPAID: '未支付', ACTIVE: '启用', INACTIVE: '停用', STUDYING: '在读', WITHDRAWN: '退学',
  COMPLETED: '已完成', SCHEDULED: '待上课', CANCELLED: '已取消', L1: '低风险', L2: '高风险',
  BOOK_SALE: '卖书', INSTRUMENT_SALE: '卖琴', EXTERNAL_COOPERATION: '外部合作', OTHER_INCOME: '其他经营收入',
  RENT_PROPERTY: '房租物业', UTILITIES_NETWORK: '水电网络', MARKETING: '营销', OFFICE_SUPPLIES: '办公用品',
  MAINTENANCE: '维修', BOOK_PURCHASE_COST: '图书采购成本', INSTRUMENT_PURCHASE_COST: '琴类采购成本',
  EXTERNAL_COOPERATION_COST: '外部合作成本', OTHER_EXPENSE: '其他支出',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isHidden = (key: string) => HIDDEN_KEYS.has(key) || /^.+(?:Id|Ids)$/.test(key);

function labelFor(key: string, actionType?: string): string {
  if (key === 'name' && actionType?.startsWith('teacher.')) return '教师姓名';
  if (key === 'name' && actionType?.startsWith('student.')) return '学生姓名';
  if (key === 'name' && actionType?.startsWith('course.')) return '课程名称';
  if (LABELS[key]) return LABELS[key]!;
  if (/^before[A-Z]/.test(key)) return `原${labelFor(key.slice(6), actionType)}`;
  if (/^after[A-Z]/.test(key)) return `新${labelFor(key.slice(5), actionType)}`;
  return '其他信息';
}

function formatScalar(key: string, value: unknown): string {
  if (typeof value === 'boolean') {
    if (key === 'createsLoginAccount') return value ? '会创建登录账号' : '不会创建登录账号';
    if (['isActive', 'enabled'].includes(key)) return value ? '启用' : '停用';
    return value ? '是' : '否';
  }
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value !== 'string') return String(value);
  if (ENUMS[value]) return ENUMS[value]!;
  if (key.endsWith('At')) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }
  if (isMoneyField(key) && /^-?\d+(?:\.\d+)?$/.test(value)) return `¥${value}`;
  if (/(?:Rate|Percentage)$/.test(key) && /^-?\d+(?:\.\d+)?$/.test(value)) return `${value}%`;
  return value;
}

function isMoneyField(key: string): boolean {
  return /(amount|balance|salary|revenue|cost|price(?:Snapshot)?|income|expense|refund|consumed|restore)(?:Before|After)?$/i.test(key) ||
    /^(?:before|after)(?:BaseSalary|BonusAmount|DeductionAmount|Balance|UnitPrice)$/.test(key);
}

function renderValue(key: string, value: unknown, actionType?: string): ReactNode {
  if (isRecord(value)) return <PreviewFacts value={value} actionType={actionType} nested />;
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null && item !== undefined);
    if (!items.length) return '—';
    return <div className="preview-facts-list">{items.map((item, index) => <div className="preview-fact-item" key={`${key}-${index}`}>
      {isRecord(item) ? <PreviewFacts value={item} actionType={actionType} nested /> : formatScalar(key, item)}
    </div>)}</div>;
  }
  return formatScalar(key, value);
}

export function PreviewFacts({ value, actionType, nested = false }: { value: Record<string, unknown>; actionType?: string | undefined; nested?: boolean }) {
  const entries = Object.entries(value).filter(([key]) => !isHidden(key) && key !== 'title' && key !== 'summary');
  if (!entries.length) return null;
  return <dl className={nested ? 'preview-facts preview-facts-nested' : 'preview-facts'}>
    {entries.map(([key, item], index) => <div key={`${key}-${index}`}><dt>{labelFor(key, actionType)}</dt><dd>{renderValue(key, item, actionType)}</dd></div>)}
  </dl>;
}
