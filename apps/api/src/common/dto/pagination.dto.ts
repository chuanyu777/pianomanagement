import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { PaginationQuery } from '@piano/shared';

export const DEFAULT_PAGE_SIZE = 20;

/** 上限存在的意义：不让一个 ?pageSize=100000 的请求把库和内存打满。 */
export const MAX_PAGE_SIZE = 200;

/**
 * 所有列表接口统一用它。前端只需要记一套分页参数名。
 */
export class PaginationDto implements PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;
}
