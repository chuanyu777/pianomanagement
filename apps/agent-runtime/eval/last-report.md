# Agent 意图理解评估报告

运行时间：2026-10-28T15:23:08.248Z
模型：deepseek-chat　语料：72 条

## 总览

| 指标 | 数值 |
|---|---|
| 通过 | 72 / 72（100.0%） |
| 模型调用总次数 | 73（含纠错重试） |
| 触发纠错重试的用例 | 1 |
| 与确定性规则可对照的用例 | 4 |
| 其中模型与规则一致 | 4（100.0%） |

## 按期望能力分组

| 期望操作 | 通过 / 总数 | 通过率 |
|---|---|---|
| accounts.read | 2 / 2 | 100% |
| arrears.read | 2 / 2 | 100% |
| clarify | 3 / 3 | 100% |
| consumption.read | 2 / 2 | 100% |
| course-account.open | 2 / 2 | 100% |
| course-account.price | 1 / 1 | 100% |
| course.create | 2 / 2 | 100% |
| course.update | 2 / 2 | 100% |
| directory.read | 3 / 3 | 100% |
| gift.preview | 2 / 2 | 100% |
| ledger-entry.reversal | 2 / 2 | 100% |
| ledger.read | 2 / 2 | 100% |
| lesson.cancel | 2 / 2 | 100% |
| lesson.complete | 2 / 2 | 100% |
| lesson.complete.correction | 1 / 1 | 100% |
| lesson.complete.reversal | 1 / 1 | 100% |
| lesson.reschedule | 2 / 2 | 100% |
| lesson.schedule | 3 / 3 | 100% |
| lessons.read | 4 / 4 | 100% |
| manual-transaction.create | 2 / 2 | 100% |
| overview.read | 2 / 2 | 100% |
| payment.preview | 3 / 3 | 100% |
| payroll.adjust | 1 / 1 | 100% |
| payroll.cancel-payment | 1 / 1 | 100% |
| payroll.generate | 2 / 2 | 100% |
| payroll.pay | 1 / 1 | 100% |
| payroll.read | 2 / 2 | 100% |
| period.close | 1 / 1 | 100% |
| period.preclose.read | 2 / 2 | 100% |
| period.reopen | 1 / 1 | 100% |
| refund.preview | 2 / 2 | 100% |
| report.monthly | 3 / 3 | 100% |
| student.create | 2 / 2 | 100% |
| student.update | 2 / 2 | 100% |
| teacher.compensation.update | 2 / 2 | 100% |
| teacher.create | 2 / 2 | 100% |
| unsupported | 1 / 1 | 100% |

## 未通过明细

全部通过。

## 规则与模型分歧（供参考）

无分歧。
