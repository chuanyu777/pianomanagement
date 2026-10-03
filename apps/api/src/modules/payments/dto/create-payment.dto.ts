import { IsDateString, IsNumber, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * 记一笔交费（US-ML-02）。
 *
 * amount > 0 是业务规则，由 service 判（前端判断能被绕过）；这里只约束传输格式。
 * occurredAt 不传则取当前时间，归属月份由此决定（关账校验也按它）。
 */
export class CreatePaymentDto {
  @IsUUID()
  enrollmentId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  amount!: number;

  @IsUUID()
  incomeItemId!: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}
