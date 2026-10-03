import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RefundMode } from '../../../prisma/generated.js';

/**
 * 退费或保留余额（US-RF-02 / US-RF-03）。
 *
 * `feeRate` 不传则取 `Organization.refundFeeRate`（逐笔可覆盖）。
 * 到 service 再转成 Decimal，并用它做金额运算 —— 这里收 number 只是 JSON 传输形态。
 */
export class CreateRefundDto {
  @IsUUID()
  studentId!: string;

  @IsEnum(RefundMode, { message: 'mode 只能是 REFUND / KEEP' })
  mode!: RefundMode;

  /** 归属月份由此时间点决定；不传取当前时间。 */
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0, { message: '退费手续费率必须在 0~1 之间' })
  @Max(1, { message: '退费手续费率必须在 0~1 之间' })
  feeRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
