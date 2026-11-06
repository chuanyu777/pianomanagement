import { describe, expect, it } from 'vitest';
import { recoveryDestination } from './recovery-destination.js';

describe('错误恢复页面',()=>{
  it('根据业务类型返回相关页面',()=>{
    expect(recoveryDestination('/', ['course-account.payment'])).toBe('/students');
    expect(recoveryDestination('/', ['lesson.reschedule'])).toBe('/schedule');
    expect(recoveryDestination('/', ['payroll.pay'])).toBe('/finance');
    expect(recoveryDestination('/', ['teacher.create'])).toBe('/settings');
  });
  it('无法确定业务时不误导用户跳到财务',()=>{
    expect(recoveryDestination('/', [])).toBeNull();
    expect(recoveryDestination('/students', [])).toBe('/students');
  });
});
