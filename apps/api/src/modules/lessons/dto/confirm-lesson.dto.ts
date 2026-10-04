import { IsDateString, IsOptional } from 'class-validator';

/**
 * 确认上课的入参。
 *
 * `confirmedAt` 只有**店主**能用（service 里强制），用来补录漏点的课 ——
 * 课时归属月份由它决定，所以补录能落到正确的月份。
 * 老师确认时一律由服务端取当前时间。
 */
export class ConfirmLessonDto {
  @IsOptional()
  @IsDateString({}, { message: 'confirmedAt 必须是合法的 ISO 时间' })
  confirmedAt?: string;
}
