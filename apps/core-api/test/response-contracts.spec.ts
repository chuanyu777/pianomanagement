import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const assistantActionsController = read(
  '../src/modules/assistant-actions/assistant-actions.controller.ts',
);
const internalToolsController = read('../src/modules/internal-tools/internal-tools.controller.ts');

describe('接口文档必须写清响应字段', () => {
  it('预览响应不得退回「只写 required、没有 properties」的空声明', () => {
    // 这种写法会让接口文档导出成空对象，客户端只能靠手抄一份结构，最终两边漂移。
    const emptyDeclaration = /@Api(?:Ok|Created)Response\(\{\s*schema:\s*\{\s*type:\s*'object',\s*required:\s*\[[^\]]*\]\s*\}\s*\}\)/gu;
    expect(assistantActionsController.match(emptyDeclaration)).toBeNull();
  });

  it('预览响应声明和确认响应声明都来自协议包定义', () => {
    expect(assistantActionsController).toContain('documentedSchema(SingleLessonPreviewResponseSchema)');
    expect(assistantActionsController).toContain('documentedSchema(PaymentPreviewResponseSchema)');
    expect(assistantActionsController).toContain('documentedSchema(GiftPreviewResponseSchema)');
    expect(assistantActionsController).toContain('documentedSchema(FinalRefundPreviewResponseSchema)');
    expect(assistantActionsController).toContain('documentedSchema(PreviewReceiptSchema)');
    expect(internalToolsController).toContain('documentedSchema(DashboardSummarySchema)');
    expect(internalToolsController).toContain('documentedSchema(TeacherCandidatesResponseSchema)');
  });

  it('内部只读接口不得只有描述、没有结构', () => {
    const descriptionOnly = /@ApiOkResponse\(\{\s*description:/gu;
    expect(internalToolsController.match(descriptionOnly)).toBeNull();
  });
});

describe('用户输入与系统计算的边界', () => {
  it('排课只需要开始时间，结束时间必须由 Core 计算', () => {
    const schema = /const SingleLessonPreviewSchema = z\.object\(\{([\s\S]*?)\}\)\.strict\(\);/u.exec(
      assistantActionsController,
    );
    expect(schema).not.toBeNull();
    const body = schema![1]!;
    expect(body).toContain('startsAt');
    expect(body).not.toContain('endsAt');
  });

  it('批量排课同样只接收首节时间与周数，不接收结束时间', () => {
    const schema = /const BatchLessonPreviewSchema = z\.object\(\{([\s\S]*?)\}\)\.strict\(\);/u.exec(
      assistantActionsController,
    );
    expect(schema).not.toBeNull();
    const body = schema![1]!;
    expect(body).toContain('firstStartsAt');
    expect(body).toContain('weeks');
    expect(body).not.toContain('endsAt');
  });
});
