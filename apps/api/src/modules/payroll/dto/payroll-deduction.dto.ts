import { IsNumber, IsUUID, Min } from 'class-validator';

/**
 * 代扣项明细。金额以数字传输（传输格式），到 service 立即转成 Decimal ——
 * 金额一律 Decimal 运算，禁止 number 参与加减。
 */
export class PayrollDeductionDto {
  @IsUUID()
  deductionItemId!: string;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: '代扣金额最多两位小数' })
  @Min(0, { message: '代扣金额不能为负' })
  amount!: number;
}
