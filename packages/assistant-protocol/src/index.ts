import { z } from 'zod';

export const protocolVersion = '1.0' as const;

export const ASSISTANT_CAPABILITY_HEADER = 'x-assistant-capability' as const;
export const INTERNAL_REQUEST_TIMESTAMP_HEADER = 'x-internal-timestamp' as const;
export const INTERNAL_REQUEST_NONCE_HEADER = 'x-internal-nonce' as const;
export const INTERNAL_REQUEST_SIGNATURE_HEADER = 'x-internal-signature' as const;

export const MoneyStringSchema = z
  .string()
  .regex(/^-?(0|[1-9]\d*)\.\d{2}$/, '金额必须是带两位小数的十进制定点字符串');

export const RiskLevelSchema = z.enum(['L0', 'L1', 'L2']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export const WorkspaceResultKindSchema = z.enum([
  'query',
  'clarification',
  'selection',
  'preview',
  'receipt',
  'error',
]);
export type WorkspaceResultKind = z.infer<typeof WorkspaceResultKindSchema>;

export const SourceReferenceSchema = z.object({
  type: z.enum(['student', 'courseAccount', 'lesson', 'ledgerEntry', 'report']),
  id: z.string().min(1),
  label: z.string().min(1),
});

export const ActionPreviewBlockSchema = z.object({
  type: z.literal('action-preview'),
  previewId: z.string().uuid(),
  actionType: z.string().min(1),
  schemaVersion: z.string().min(1),
  title: z.string().min(1),
  riskLevel: RiskLevelSchema,
  expiresAt: z.iso.datetime(),
});

export const HistoricalPreviewReferenceSchema = z.object({
  previewId: z.string().uuid(),
  actionType: z.string().min(1),
  schemaVersion: z.string().min(1),
  riskLevel: RiskLevelSchema,
});
export type HistoricalPreviewReference = z.infer<typeof HistoricalPreviewReferenceSchema>;

export const ReceiptBlockSchema = z.object({
  type: z.literal('receipt'),
  receiptId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['succeeded', 'failed']),
  occurredAt: z.iso.datetime(),
});

export const WorkspaceBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('summary'),
    title: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal('alert-list'),
    alerts: z.array(
      z.object({
        severity: z.enum(['info', 'warning', 'error']),
        title: z.string().min(1),
        detail: z.string().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('entity-picker'),
    title: z.string().min(1),
    candidates: z.array(
      z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional() }),
    ),
  }),
  z.object({
    type: z.literal('data-table'),
    columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }),
  z.object({
    type: z.literal('calendar'),
    rangeStart: z.iso.datetime(),
    rangeEnd: z.iso.datetime(),
    events: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        start: z.iso.datetime(),
        end: z.iso.datetime(),
      }),
    ),
  }),
  z.object({
    type: z.literal('metric-grid'),
    metrics: z.array(
      z.object({
        label: z.string().min(1),
        value: z.string(),
        tone: z.enum(['neutral', 'positive', 'warning']).default('neutral'),
      }),
    ),
  }),
  z.object({
    type: z.literal('ledger-detail'),
    accountId: z.string().min(1),
    entries: z.array(
      z.object({
        id: z.string().min(1),
        occurredAt: z.iso.datetime(),
        description: z.string().min(1),
        paidDelta: MoneyStringSchema,
        giftDelta: MoneyStringSchema,
      }),
    ),
  }),
  z.object({
    type: z.literal('calculation-breakdown'),
    title: z.string().min(1),
    lines: z.array(z.object({ label: z.string().min(1), amount: MoneyStringSchema })),
    total: MoneyStringSchema,
  }),
  ActionPreviewBlockSchema,
  ReceiptBlockSchema,
  z.object({
    type: z.literal('error-recovery'),
    code: z.string().min(1),
    message: z.string().min(1),
    actions: z.array(z.enum(['refresh', 'repreview', 'open-structured-page'])),
  }),
]);

export const WorkspaceDocumentSchema = z.object({
  protocolVersion: z.literal(protocolVersion),
  resultKind: WorkspaceResultKindSchema.optional(),
  title: z.string().min(1),
  blocks: z.array(WorkspaceBlockSchema),
  sources: z.array(SourceReferenceSchema).default([]),
  taskVersion: z.number().int().nonnegative().optional(),
});
export type WorkspaceDocument = z.infer<typeof WorkspaceDocumentSchema>;

export const AssistantRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_input',
  'completed',
  'failed',
]);
export type AssistantRunStatus = z.infer<typeof AssistantRunStatusSchema>;

export const AssistantRunSchema = z.object({
  runId: z.string().uuid(),
  threadId: z.string().uuid(),
  status: AssistantRunStatusSchema,
});
export type AssistantRun = z.infer<typeof AssistantRunSchema>;

export const AssistantStartRequestSchema = z.object({
  runId: z.string().uuid(),
  threadId: z.string().uuid(),
  userMessage: z.string().min(1).max(4_000),
  clientRequestId: z.string().min(1).max(200).optional(),
});
export type AssistantStartRequest = z.infer<typeof AssistantStartRequestSchema>;

export const AssistantResumeInputSchema = z.object({
  approved: z.boolean(),
});
export type AssistantResumeInput = z.infer<typeof AssistantResumeInputSchema>;

export const AssistantResumeRequestSchema = z.object({
  threadId: z.string().uuid(),
  input: AssistantResumeInputSchema,
});
export type AssistantResumeRequest = z.infer<typeof AssistantResumeRequestSchema>;

export const AssistantEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    runId: z.string().uuid(),
    threadId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('assistant.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('assistant.message'),
    messageId: z.string().uuid(),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal('progress.changed'),
    label: z.string().min(1),
    percent: z.number().min(0).max(100).optional(),
  }),
  z.object({
    type: z.literal('workspace.replace'),
    document: WorkspaceDocumentSchema,
  }),
  z.object({
    type: z.literal('workspace.patch'),
    operations: z.array(
      z.object({
        op: z.enum(['add', 'replace', 'remove']),
        path: z.string().startsWith('/'),
        value: z.unknown().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('clarification.requested'),
    question: z.string().min(1),
  }),
  z.object({
    type: z.literal('action.previewed'),
    preview: ActionPreviewBlockSchema,
  }),
  z.object({
    type: z.literal('action.stale'),
    previewId: z.string().uuid(),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('action.executed'),
    previewId: z.string().uuid(),
    receipt: ReceiptBlockSchema,
  }),
  z.object({
    type: z.literal('run.completed'),
    runId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('run.failed'),
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

export function encodeSseEvent(event: AssistantEvent): string {
  const checked = AssistantEventSchema.parse(event);
  return `event: ${checked.type}\ndata: ${JSON.stringify(checked)}\n\n`;
}
