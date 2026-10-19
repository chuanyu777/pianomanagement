import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentChannel } from '../../generated/prisma/client.js';

export class CreateRefundBody {
  @ApiProperty({ type: String, example: '20.00', description: '手续费，最多两位小数' })
  feeAmount!: string;

  @ApiProperty({ enum: PaymentChannel })
  channel!: PaymentChannel;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  note?: string;
}

export class RefundDetailResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;

  @ApiProperty({ type: String, example: '100.00' })
  paidBalanceBefore!: string;

  @ApiProperty({ type: String, example: '20.00' })
  giftBalanceBefore!: string;

  @ApiProperty({ type: String, example: '100.00' })
  paidRefundAmount!: string;

  @ApiProperty({ type: String, example: '20.00' })
  giftClearingAmount!: string;
}

export class RefundResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  studentId!: string;

  @ApiProperty({ type: String, example: '100.00' })
  totalPaidRefund!: string;

  @ApiProperty({ type: String, example: '10.00' })
  feeAmount!: string;

  @ApiProperty({ type: String, example: '10.00' })
  feePercentage!: string;

  @ApiProperty({ type: String, example: '90.00' })
  actualRefundAmount!: string;

  @ApiProperty({ enum: PaymentChannel })
  channel!: PaymentChannel;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: Date;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: RefundDetailResponse, isArray: true })
  details!: RefundDetailResponse[];
}
