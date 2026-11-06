import { describe, expect, it, vi } from 'vitest';
import { createIntentParser, SYSTEM_PROMPT } from '../src/graph/intent-parser.js';
import { createDialogueGraph } from '../src/graph/dialogue-graph.js';

function reviewed(invoke: ReturnType<typeof vi.fn>, review: {actionSupported:boolean;unsupportedFields:string[]} = {actionSupported:true,unsupportedFields:[]}) {
  return {invoke: async (...args: unknown[]) => {
    const messages = args[0] as {content:string}[];
    if (messages[0]?.content.startsWith('核对候选缴费意图')) return {content:JSON.stringify(review)};
    return invoke(...args);
  }};
}

describe('生产模型意图理解输入', () => {
  it('对缴费意图由模型统一核对用户所述字段，而非依靠关键词决定是否核对', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',amount:'100',channel:'微信'},question:null})})
      .mockResolvedValueOnce({content:JSON.stringify({actionSupported:true,unsupportedFields:[]})});
    const result = await createIntentParser({invoke} as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课缴费100元，微信'});
    expect(result).toMatchObject({kind:'parsed',intent:{operation:'payment.preview',fields:{amount:'100',channel:'微信'}}});
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('用户以现钞表达现金渠道时接受模型理解，不要求原文出现标准渠道名', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',amount:'100',channel:'现金'},question:null})})
      .mockResolvedValueOnce({content:JSON.stringify({actionSupported:true,unsupportedFields:[]})});
    const result = await createIntentParser({invoke} as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦交100元，收现钞'});
    expect(result).toMatchObject({kind:'parsed',intent:{fields:{channel:'现金'}}});
  });
  it('用户以课时按价表达单节价格时接受模型理解', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',amount:'1000',channel:'微信',currentUnitPrice:'180'},question:null})})
      .mockResolvedValueOnce({content:JSON.stringify({actionSupported:true,unsupportedFields:[]})});
    const result = await createIntentParser({invoke} as never)({businessDate:'2026-10-21',task:{},userMessage:'林悦交1000元微信，课时按180'});
    expect(result).toMatchObject({kind:'parsed',intent:{fields:{currentUnitPrice:'180'}}});
  });
  it('“不要少交”属于要求交费时由模型判定而不被否定词一律拦截', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',amount:'100',channel:'微信'},question:null})})
      .mockResolvedValueOnce({content:JSON.stringify({actionSupported:true,unsupportedFields:[]})});
    const result = await createIntentParser({invoke} as never)({businessDate:'2026-10-21',task:{},userMessage:'不要少交100元微信'});
    expect(result).toMatchObject({kind:'parsed',intent:{mode:'new',operation:'payment.preview'}});
  });
  it('长会话总结与意图理解均先遮盖已知姓名，且保留摘要', async () => {
    const invoke = vi.fn().mockImplementation(async messages => ({content:messages[0].content.startsWith('整理对话')
      ? '用户此前提到实体1。'
      : JSON.stringify({mode:'new',operation:'accounts.read',fields:{studentName:'实体1'},question:null})}));
    const history = Array.from({length:18}, (_, index) => ({role:'user' as const,content:`林悦第${index}次说话${'字'.repeat(1000)}`}));
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{references:[{values:{studentName:'林悦'}}]},history,userMessage:'查询她的余额'});
    expect(result).toMatchObject({kind:'parsed',intent:{fields:{studentName:'林悦'}}});
    expect(invoke.mock.calls.every(call => !call[0][1].content.includes('林悦'))).toBe(true);
    const finalInput = JSON.parse(invoke.mock.calls.at(-1)![0][1].content);
    expect(JSON.stringify(finalInput.history)).toContain('此前提到实体1');
  });
  it('历史摘要服务失败时不再尝试用残缺上下文办理', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('offline'));
    const history = Array.from({length:18}, () => ({role:'user' as const,content:'记录'.repeat(600)}));
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{},history,userMessage:'按刚才说的办理'});
    expect(result).toEqual({kind:'unavailable',detail:'history-summary-unavailable'});
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('不超过上下文预算的对话完整交给意图模型理解', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'continue',operation:'payment.preview',fields:{channel:'微信'},question:null})});
    const history = Array.from({length:10}, (_, i) => ({role:'user' as const,content:`第${i}条${'字'.repeat(1000)}`}));
    await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{},history,userMessage:'微信'});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.parse(invoke.mock.calls[0]![0][1].content).history).toEqual(history);
  });
  it('允许模型结合本会话用户消息理解代词及明确给出的缴费信息', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'张小鱼',courseName:'主课',amount:'2000',channel:'微信'},question:null})});
    const history = [{role:'user' as const,content:'张小鱼主课缴费2000元，微信'},{role:'assistant' as const,content:'还需要确认吗？'}];
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{},history,userMessage:'就按刚才说的给他办理'});
    expect(result).toMatchObject({kind:'parsed',intent:{fields:{studentName:'张小鱼',amount:'2000',channel:'微信'}}});
    expect(SYSTEM_PROMPT).toContain('结合本会话历史');
    expect(JSON.parse(invoke.mock.calls[0]![0][1].content).history).toEqual(history);
  });
  it('不能把助手历史回复中的数字和渠道当成用户提供的缴费信息', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'张小鱼',amount:'2000',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['amount','channel']}) as never)({businessDate:'2026-10-21',task:{},history:[{role:'assistant',content:'例如缴费2000元，微信支付'}],userMessage:'给张小鱼缴费'});
    expect(result).toMatchObject({kind:'parsed',intent:{fields:{studentName:'张小鱼'}}});
    if (result.kind === 'parsed') {
      expect(result.intent.fields.amount).toBeUndefined();
      expect(result.intent.fields.channel).toBeUndefined();
    }
  });
  it('预算内的会话完整交给意图理解前先遮盖已知姓名', async () => {
    const invoke = vi.fn().mockImplementation(async messages => ({content:messages[0].content.startsWith('整理对话')
      ? '用户此前提到实体1。'
      : JSON.stringify({mode:'new',operation:'accounts.read',fields:{studentName:'实体1'},question:null})}));
    const history = Array.from({length:10}, (_, index) => ({role:'user' as const,content:`林悦第${index}次说话${'字'.repeat(1000)}`}));
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{references:[{values:{studentName:'林悦'}}]},history,userMessage:'查询她的余额'});
    expect(result).toMatchObject({kind:'parsed',intent:{fields:{studentName:'林悦'}}});
    expect(invoke.mock.calls.every(call => !call[0][1].content.includes('林悦'))).toBe(true);
    const finalInput = JSON.parse(invoke.mock.calls.at(-1)![0][1].content);
    expect(finalInput.history).toEqual(history.map(message => ({...message,content:message.content.replaceAll('林悦','实体1')})));
  });
  it('预算内完整历史模型调用失败时不再尝试用残缺上下文办理', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('offline'));
    const history = Array.from({length:10}, () => ({role:'user' as const,content:'记录'.repeat(600)}));
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{},history,userMessage:'按刚才说的办理'});
    expect(result).toEqual({kind:'unavailable',detail:'offline'});
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('向模型明确区分发工资和算工资', () => {
    expect(SYSTEM_PROMPT).toContain('发工资');
    expect(SYSTEM_PROMPT).toContain('payroll.pay');
    expect(SYSTEM_PROMPT).toContain('不等于生成工资');
  });
  it('模型错误地把明确否定的单一动作识别成交费时要求澄清', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:false,unsupportedFields:[]}) as never)({businessDate:'2026-10-21',task:{},userMessage:'不要给林悦主课交费100元'});
    expect(result).toMatchObject({kind:'parsed',intent:{mode:'clarify',operation:null,fields:{}}});
  });
  it.each(['continue','correct'] as const)('模型把否定操作误判为 %s 时不得继续生成该操作', async mode => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode,operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:false,unsupportedFields:[]}) as never)({businessDate:'2026-10-21',task:{status:'collecting',operation:'payment.preview'},userMessage:'不要给林悦主课交费100元'});
    expect(result).toMatchObject({kind:'parsed',intent:{mode:'clarify',operation:null,fields:{}}});
  });
  it('否定交费但明确要求查余额时仍保留余额查询', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'accounts.read',fields:{studentName:'林悦',courseName:'主课'},question:null})});
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{},userMessage:'不要交费只查林悦主课余额'});
    expect(result).toMatchObject({kind:'parsed',intent:{mode:'new',operation:'accounts.read',fields:{studentName:'林悦',courseName:'主课'}}});
  });
  it('否定支付渠道并明确要求交费时仍保留交费意图', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{},userMessage:'不用现金用微信给林悦主课交费100元'});
    expect(result).toMatchObject({kind:'parsed',intent:{mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}}});
  });
  it('模型凭空补充支付渠道时移除该字段并交由后续追问', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['channel']}) as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课交费100元'});
    expect(result).toMatchObject({kind:'parsed',intent:{mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100'}}});
    if(result.kind!=='parsed') throw new Error('expected parsed intent');
    expect(result.intent.fields).not.toHaveProperty('channel');
  });
  it('用户没有提及单节价格时，不接受模型凭空添加的改价', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信',currentUnitPrice:'180'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['currentUnitPrice']}) as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课微信交费1000元'});
    if(result.kind!=='parsed') throw new Error('expected parsed intent');
    expect(result.intent.fields).not.toHaveProperty('currentUnitPrice');
  });
  it('凭空补充的渠道不能让对话生成交费预览', async () => {
    const invoke=vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const tools={checkActionAccess:vi.fn().mockResolvedValue({allowed:true}),getStudentCandidates:vi.fn().mockResolvedValue({candidates:[]}),createPaymentPreview:vi.fn()};
    const graph=createDialogueGraph({capability:'cap',tools:tools as never,intentParser:createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['channel']}) as never)});
    const {result}=await graph.invoke({turn:{runId:crypto.randomUUID(),threadId:crypto.randomUUID(),message:'给林悦主课交费100元',previous:{}}});
    expect(result.workspace.resultKind).toBe('clarification');
    expect(result.answer).toContain('渠道');
    expect(tools.getStudentCandidates).not.toHaveBeenCalled();
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('没有提到数字时不能采用模型凭空补出的金额', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['amount']}) as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课交费，微信支付'});
    if(result.kind!=='parsed') throw new Error('expected parsed intent');
    expect(result.intent.fields).not.toHaveProperty('amount');
  });
  it('口语数字金额仍可由模型理解', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'150',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke) as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课交一百五，微信支付'});
    expect(result).toMatchObject({kind:'parsed',intent:{fields:{amount:'150'}}});
  });
  it('学生和课程名称中的数字不算交费金额', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦123',courseName:'钢琴1班',amount:'100',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['amount']}) as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦123的钢琴1班交费，微信支付'});
    if(result.kind!=='parsed') throw new Error('expected parsed intent');
    expect(result.intent.fields).not.toHaveProperty('amount');
  });
  it('一笔交费这样的数量词不应被当作金额', async () => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const result = await createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['amount']}) as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课用微信登记一笔交费'});
    if(result.kind!=='parsed') throw new Error('expected parsed intent');
    expect(result.intent.fields).not.toHaveProperty('amount');
  });
  it('凭空补充金额时对话要求补充且不生成预览', async () => {
    const invoke=vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null})});
    const tools={checkActionAccess:vi.fn().mockResolvedValue({allowed:true}),getStudentCandidates:vi.fn(),createPaymentPreview:vi.fn()};
    const graph=createDialogueGraph({capability:'cap',tools:tools as never,intentParser:createIntentParser(reviewed(invoke, {actionSupported:true,unsupportedFields:['amount']}) as never)});
    const {result}=await graph.invoke({turn:{runId:crypto.randomUUID(),threadId:crypto.randomUUID(),message:'给林悦主课交费，微信支付',previous:{}}});
    expect(result.workspace.resultKind).toBe('clarification');
    expect(result.answer).toContain('金额');
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it.each([
    ['林悦主课余額还有多少', 'accounts.read', {studentName:'林悦',courseName:'主课'}],
    ['主课林悦还剩多少钱', 'accounts.read', {studentName:'林悦',courseName:'主课'}],
    ['帮我看看2026年10月房租支出', 'report.monthly', {period:'2026-10'}],
    ['林悦主课收100元微信', 'payment.preview', {studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}],
  ])('将原话和语言规则交给模型，采用模型结果：%s', async (message, operation, fields) => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation,fields,question:null})});
    const result = await createIntentParser(reviewed(invoke) as never, {shadowRules:true})({businessDate:'2026-10-21',task:{},userMessage:message});
    const messages = invoke.mock.calls[0]![0] as {content:string}[];
    expect(messages[0]!.content).toContain('同义');
    expect(messages[0]!.content).toContain('语序');
    expect(messages[0]!.content).toContain('错别字');
    expect(messages[0]!.content).toContain('不得纠正或猜测人名');
    expect(messages[0]!.content).toContain('明确否定某个动作');
    expect(JSON.parse(messages[1]!.content).userMessage).toBe(message);
    expect(result).toMatchObject({kind:'parsed',source:'model',intent:{operation,fields}});
  });
});
