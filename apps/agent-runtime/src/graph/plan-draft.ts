/** Draft-only identity references. Core remains the source of business records. */
export function applySubjectNameCorrection<T extends {
  revision: number;
  subjects: Array<{ id: string; name: string }>;
  steps: Array<{ id: string; subjectId: string }>;
}>(plan: T, input: { subjectId: string; name: string; expectedRevision: number }): T {
  const name = input.name.trim();
  if (plan.revision !== input.expectedRevision || !name || plan.subjects.filter(subject => subject.id === input.subjectId).length !== 1) {
    throw new Error('无法应用办理对象更正');
  }
  return {
    ...plan,
    revision: plan.revision + 1,
    subjects: plan.subjects.map(subject => subject.id === input.subjectId ? { ...subject, name } : subject),
  };
}
