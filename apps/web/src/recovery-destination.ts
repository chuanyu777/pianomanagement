/** Only offer navigation when the current business context is unambiguous. */
export function recoveryDestination(pathname:string, actionTypes:string[]):string|null {
  const paths=new Set(actionTypes.flatMap(action=>{
    if(action.startsWith('student.')||action.startsWith('course-account.')||action.startsWith('ledger-entry.'))return ['/students'];
    if(action.startsWith('lesson.'))return ['/schedule'];
    if(action.startsWith('teacher.')||action.startsWith('course.'))return ['/settings'];
    if(action.startsWith('payroll.')||action.startsWith('period.')||action.startsWith('manual-transaction.'))return ['/finance'];
    return [];
  }));
  if(paths.size===1)return [...paths][0]!;
  if(paths.size>1)return null;
  return ['/students','/schedule','/settings','/finance'].find(path=>pathname===path||pathname.startsWith(`${path}/`))??null;
}
