import type { DialogueIntent, IntentContext } from './dialogue-intent.js';

const NAME_KEYS = ['studentName', 'teacherName', 'courseName'] as const;

type CandidateLike = { values?: Record<string, unknown> };

function candidateLists(task: unknown): CandidateLike[] {
  if (!task || typeof task !== 'object') return [];
  const record = task as Record<string, unknown>;
  const merged = [
    ...(Array.isArray(record['candidates']) ? record['candidates'] : []),
    ...(Array.isArray(record['references']) ? record['references'] : []),
  ];
  return merged.filter((item): item is CandidateLike => typeof item === 'object' && item !== null);
}

export type NameMask = {
  maskedContext: IntentContext;
  restoreIntent: (intent: DialogueIntent) => DialogueIntent;
  maskedNameCount: number;
};

/**
 * Replaces known student, teacher and course names with stable placeholders before
 * the message leaves the process. Names are only known from the candidates and
 * references already loaded from Core, so this reduces what third parties see
 * without changing what the model can understand.
 *
 * Substitution is reversible: restoring the placeholders reproduces the original
 * text exactly, including the case where one name is a prefix of another
 * ("小明" inside "小明光"), because longer names are replaced first.
 */
export function buildNameMask(context: IntentContext): NameMask {
  const names = new Set<string>();
  for (const item of candidateLists(context.task)) {
    for (const key of NAME_KEYS) {
      const value = item.values?.[key];
      if (typeof value === 'string' && value.trim().length > 0) names.add(value.trim());
    }
  }
  if (names.size === 0) {
    return { maskedContext: context, restoreIntent: (intent) => intent, maskedNameCount: 0 };
  }

  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  [...names]
    .sort((a, b) => b.length - a.length)
    .forEach((name, index) => {
      const placeholder = `实体${index + 1}`;
      forward.set(name, placeholder);
      backward.set(placeholder, name);
    });

  const maskText = (text: string): string => {
    let out = text;
    for (const [real, placeholder] of forward) out = out.split(real).join(placeholder);
    return out;
  };
  const restoreText = (text: string): string => {
    let out = text;
    for (const [placeholder, real] of backward) out = out.split(placeholder).join(real);
    return out;
  };
  const maskTask = (value: unknown): unknown => {
    if (typeof value === 'string') return maskText(value);
    if (Array.isArray(value)) return value.map(maskTask);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskTask(item)]));
  };

  return {
    maskedContext: { ...context, userMessage: maskText(context.userMessage), task: maskTask(context.task), ...(context.history ? {history:context.history.map(message => ({...message,content:maskText(message.content)}))} : {}) },
    restoreIntent: (intent) => ({
      ...intent,
      fields: Object.fromEntries(
        Object.entries(intent.fields).map(([key, value]) => [key, typeof value === 'string' ? restoreText(value) : value]),
      ),
      question: typeof intent.question === 'string' ? restoreText(intent.question) : intent.question,
    }),
    maskedNameCount: names.size,
  };
}
