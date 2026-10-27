// Expectations are derived from the reviewed 83-case document, not tool registration.
export const groups={
  Q01:'GSummary',Q02:'G',Q03:'G',Q04:'F1',Q05:'F1',Q06:'F1B',Q07:'F1B',Q08:'List',Q09:'Consumption',Q10:'F4',Q11:'F4',
  B01:'F1',B02:'B2',B03:'F3',B04:'F1',B05:'F1B',B06:'B6',B07:'F1B',
  S01:'F1',S02:'F1',S03:'F1',S04:'BatchConflict',S05:'G',S06:'G',S07:'GM',S08:'G',S09:'F1',S10:'G',S11:'F1B',S12:'F1B',
  F01:'F1',F02:'F1',F03:'F1',F04:'F1',F05:'F1',F06:'F1',F07:'F1Error',
  R01:'F2',R02:'F2',R03:'F2Debt',R04:'F2Zero',R05:'F2',R06:'F2',
  W01:'F3',W02:'F3New',W03:'F3',W04:'F3Base',W05:'F3',W06:'PayrollSeptember',W07:'F3Paid',W08:'F3Closed',
  M01:'F1',M02:'F1',M03:'F1',K01:'Preclose',K02:'F1',K03:'KClosed',K04:'KClosedMatrix',K05:'History',
  C01:'F1',C02:'C2',C03:'G',C04:'F1',C05:'F1',C06:'F1',C07:'F1',C08:'F1',
  P01:'G',P02:'F1',P03:'G',P04:'F1',P05:'F1',E01:'G',E02:'F1',E03:'F1',E04:'F2',E05:'F1',E06:'F1',E07:'F1',E08:'F1',U01:'G',U02:'F2',U03:'G',
};
export const expectedActions={B01:'student.create',B02:'student.update',B03:'teacher.create',B04:'course.create',B05:'course.update',B06:'course-account.open',B07:'course-account.price',
  S01:'lesson.schedule.single',S03:'lesson.schedule.weekly-batch',S07:'lesson.reschedule',S08:'lesson.cancel',S09:'lesson.complete',S11:'lesson.complete.reversal',
  F01:'course-account.payment',F03:'course-account.gift',F07:'ledger-entry.reversal',R01:'student.final-refund',R04:'student.final-refund',
  W02:'payroll.generate',W03:'payroll.adjust',W05:'payroll.pay',M01:'manual-transaction.create',M02:'manual-transaction.create',K02:'period.close',K05:'lesson.complete.correction',
  P05:'course-account.payment',E02:'course-account.payment',E03:'course-account.payment',E04:'student.final-refund',E05:'course-account.payment',U02:'student.final-refund'};
export const prompts={Q02:['今天有哪些排课？','查询今天的排课','今天安排了什么课','查看昨天排课','昨天上了哪些课','查看明天排课','明天有哪些课','后天排课','查2026-10-23课表','查看2026-10-24的排课','查今天王老师的主课，只看待上课'],
  Q03:['查10月20日到22日的排课。','本月排课','上月排课','下月排课','查最近几天的课'],
  M01:['今天卖书收到50元，微信，登记收入。','今天卖琴收到2000元，微信，登记收入。','今天外部合作收到300元，微信，登记收入。','今天其他经营收入20元，微信，备注活动收入。'],
  M02:['今天付房租200元，银行卡，登记支出。','今天水电网络100元，银行卡，登记支出。','今天推广50元，银行卡，登记支出。','今天办公用品30元，银行卡，登记支出。','今天维修100元，银行卡，登记支出。','今天购书成本100元，银行卡，登记支出。','今天购琴成本1000元，银行卡，登记支出。','今天外部合作成本100元，银行卡，登记支出。','今天其他经营支出20元，银行卡，备注临时运输。']};
export function assertCaseInventory(ids,catalog=groups){
  const expected=Object.keys(catalog).sort();
  if(ids.length!==83||new Set(ids).size!==83||JSON.stringify([...ids].sort())!==JSON.stringify(expected))throw new Error('INDEPENDENT_CASE_INVENTORY_MISMATCH');
}
export const faultCases=new Set(['E01','E02','E03','E04','E05','E06','E07','E08']);
export const browserCases=new Set(['U01','U02','U03','P05']);
