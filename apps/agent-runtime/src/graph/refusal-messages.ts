/**
 * Maps Core rejection reasons to plain-language guidance. Keeping this table
 * separate from the business code means wording changes never touch logic, and
 * the reason codes stay stable across Core refactors.
 */
export function refusalGuidance(code: string | undefined, status: number | undefined): string | undefined {
  switch (code) {
    case 'ROLE_OWNER_ONLY':
      return '这项数据只有店主账号能查看。老师账号可以查自己的课表、本月课时和工资。';
    case 'PERIOD_CLOSED':
      return '这个月份已经关账，不能再改动资金或课消。需要补录的话，要先重开关账，办完再关回去。';
    case 'PAYROLL_ALREADY_PAID':
      return '这笔工资已经支付过了，不能重复支付。如果要更正，请先撤销支付登记。';
    case 'VERSION_CONFLICT':
      return '这笔数据刚刚被改过，请刷新后重新核对再操作。';
    case 'PREVIEW_STALE':
      return '这张确认单已经失效，请重新生成一次预览。';
    case 'NOT_FOUND':
      return '没有找到对应的业务记录，请确认学生、课程或月份是否正确。';
    case 'FORBIDDEN':
      return '当前账号没有这项操作的权限。';
    case 'CONFLICT':
      return '当前业务状态不允许这个操作，请重新核对对象和状态。';
    default:
      if (status === 403) return '当前账号没有这项操作的权限。';
      if (status === 409) return '当前业务状态不允许这个操作，请重新核对。';
      return undefined;
  }
}
