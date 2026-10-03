import { IsOptional, IsUUID } from 'class-validator';

/**
 * 待确认课列表（US-CC-01）。
 *
 * 店主可传 teacherId 只看某位老师，或留空看全部；
 * 授课老师不传、或只能传自己关联的老师 id（service 强制，见 lessons.service.ts 的 listPending）。
 */
export class ListPendingQueryDto {
  @IsOptional()
  @IsUUID()
  teacherId?: string;
}
