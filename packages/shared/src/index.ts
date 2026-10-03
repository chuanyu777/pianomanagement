/**
 * 前后端共享的「接口契约」类型。
 *
 * 硬规则：这里**只放 Prisma 表达不了的东西**（响应包装、分页信封、错误体）。
 * 枚举和实体一律以 `apps/api/prisma/schema.prisma` 为唯一来源 ——
 * 在这里再抄一份域名/角色/状态定义，就是「同一规则两份实现」，会静默跑偏，禁止。
 */

/** 分页请求参数（前端 → 后端），对应 common/dto/pagination.dto.ts */
export type PaginationQuery = {
  page?: number;
  pageSize?: number;
};

/** 分页响应体（后端 → 前端）。列表接口一律用它，前端不用猜字段名。 */
export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 统一错误响应体（后端 → 前端）。
 *
 * 前端**必须**按 `code` 分支，不要按 `message` 文本判断 ——
 * message 是给人看的，随时会改；code 才是契约。
 */
export type ApiErrorBody = {
  statusCode: number;
  message: string;
  code?: string;
  details?: Array<{ field: string; message: string }>;
};
