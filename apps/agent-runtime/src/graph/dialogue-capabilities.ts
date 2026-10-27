export type DialogueCapabilityStatus = 'connected' | 'pending-core-read' | 'pending-core-preview';
export type DialogueCapability = {
  id: string;
  kind: 'read' | 'preview';
  status: DialogueCapabilityStatus;
};

/**
 * Product capability inventory derived from the frozen MVP requirements.
 * It is intentionally independent from the registered tool list so a missing
 * binding stays visible instead of disappearing from acceptance coverage.
 */
export const MVP_DIALOGUE_CAPABILITIES = [
  { id:'overview.read',kind:'read',status:'connected' },
  { id:'lessons.read',kind:'read',status:'connected' },
  { id:'directory.read',kind:'read',status:'connected' },
  { id:'accounts.read',kind:'read',status:'connected' },
  { id:'ledger.read',kind:'read',status:'connected' },
  { id:'arrears.read',kind:'read',status:'connected' },
  { id:'consumption.read',kind:'read',status:'connected' },
  { id:'report.monthly',kind:'read',status:'connected' },
  { id:'payroll.read',kind:'read',status:'connected' },
  { id:'period.preclose.read',kind:'read',status:'connected' },
  { id:'student.create',kind:'preview',status:'connected' },
  { id:'student.update',kind:'preview',status:'connected' },
  { id:'teacher.create',kind:'preview',status:'connected' },
  { id:'teacher.compensation.update',kind:'preview',status:'connected' },
  { id:'course.create',kind:'preview',status:'connected' },
  { id:'course.update',kind:'preview',status:'connected' },
  { id:'course-account.open',kind:'preview',status:'connected' },
  { id:'course-account.price',kind:'preview',status:'connected' },
  { id:'course-account.payment',kind:'preview',status:'connected' },
  { id:'course-account.gift',kind:'preview',status:'connected' },
  { id:'ledger-entry.reversal',kind:'preview',status:'connected' },
  { id:'lesson.schedule.single',kind:'preview',status:'connected' },
  { id:'lesson.schedule.weekly-batch',kind:'preview',status:'connected' },
  { id:'lesson.reschedule',kind:'preview',status:'connected' },
  { id:'lesson.cancel',kind:'preview',status:'connected' },
  { id:'lesson.complete',kind:'preview',status:'connected' },
  { id:'lesson.complete.reversal',kind:'preview',status:'connected' },
  { id:'lesson.complete.correction',kind:'preview',status:'connected' },
  { id:'student.final-refund',kind:'preview',status:'connected' },
  { id:'payroll.generate',kind:'preview',status:'connected' },
  { id:'payroll.adjust',kind:'preview',status:'connected' },
  { id:'payroll.pay',kind:'preview',status:'connected' },
  { id:'payroll.cancel-payment',kind:'preview',status:'connected' },
  { id:'manual-transaction.create',kind:'preview',status:'connected' },
  { id:'period.close',kind:'preview',status:'connected' },
  { id:'period.reopen',kind:'preview',status:'connected' },
] as const satisfies readonly DialogueCapability[];

export function dialogueCapabilityStatus(id: string): DialogueCapabilityStatus | undefined {
  return MVP_DIALOGUE_CAPABILITIES.find(item => item.id === id)?.status;
}
