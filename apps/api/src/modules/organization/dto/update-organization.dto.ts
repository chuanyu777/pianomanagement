import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ConsumptionOrder } from '../../../prisma/generated.js';

/** 比例用 0~1 的小数传输（0.15 = 15%），到 service 再转成 Decimal。 */
export class UpdateOrganizationDto {
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsString() @MaxLength(64) city?: string;
  @IsOptional() @IsString() @MaxLength(32) reporter?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1) defaultCommissionRate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) refundFeeRate?: number;

  @IsOptional() @IsBoolean() giftCountsAsBalance?: boolean;
  @IsOptional() @IsEnum(ConsumptionOrder) consumptionOrder?: ConsumptionOrder;

  @IsOptional() @IsNumber() @Min(0) initialCashBalance?: number;
  @IsOptional() @IsNumber() @Min(0) previousMonthProfit?: number;
  @IsOptional() @IsNumber() @Min(0) previousMonthPayroll?: number;
}
