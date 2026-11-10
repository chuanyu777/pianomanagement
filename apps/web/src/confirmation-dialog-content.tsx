import { Alert } from 'antd';
import type { AssistantPreviewDraft } from './assistant-client.js';
import { PreviewFacts } from './preview-facts.js';
import './confirmation-dialog-content.css';

export type ConfirmationState = 'checking' | 'pending' | 'confirming' | 'unknown' | 'executed';

export function ConfirmationDialogContent({ preview, state, message, receipt }: {
  preview: AssistantPreviewDraft & { success: string };
  state: ConfirmationState;
  message: string;
  receipt: Record<string, unknown> | null;
}) {
  if (state === 'executed') return <div className="confirmation-result" role="status">
    <div className="confirmation-result-heading"><span aria-hidden="true">✓</span><div><strong>{preview.success}</strong><p>操作已完成</p></div></div>
    <section className="confirmation-receipt" aria-label="执行回执"><strong>执行回执</strong>{receipt && <PreviewFacts value={receipt} actionType={preview.actionType} />}</section>
  </div>;
  return <div className="confirmation-content">
    <div className="confirmation-intro"><p>{typeof preview.display.summary === 'string' ? preview.display.summary : '请核对下方操作后确认执行。'}</p></div>
    <div className="confirmation-facts"><PreviewFacts value={preview.display} actionType={preview.actionType} /></div>
    {state === 'checking' && <p className="confirmation-checking" role="status">正在核对确认单状态…</p>}
    {message && <Alert className="preview-alert" message={message} type="warning" showIcon />}
  </div>;
}
