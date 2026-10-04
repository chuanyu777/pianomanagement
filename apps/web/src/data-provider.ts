import type {
  BaseRecord,
  BaseKey,
  CreateManyParams,
  CreateParams,
  CrudFilters,
  CrudSort,
  CustomParams,
  DataProvider,
  DeleteManyParams,
  DeleteOneParams,
  GetListParams,
  GetManyParams,
  GetOneParams,
  UpdateManyParams,
  UpdateParams,
} from '@refinedev/core';
import type { ApiErrorBody, Paginated } from '@piano/shared';

/**
 * 自定义 dataProvider。
 *
 * 后端的约定和 json-server 不一样（Refine 官方的 simple-rest 对不上），所以自己写：
 * - 列表统一返回 `Paginated<T>` = { items, total, page, pageSize }
 * - 单条直接返回对象本体
 * - 错误统一返回 ApiErrorBody，`message` 是给人看的、`code` 才是给程序分支用的
 * - 分页参数叫 page / pageSize，不是 json-server 的 _start/_end
 */

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('piano.access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 所有请求的唯一出口：拼头部、把后端的 ApiErrorBody 翻成带 statusCode 的 Error。 */
async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null;
    const error = new Error(payload?.message ?? response.statusText) as Error & {
      statusCode: number;
      code?: string;
    };
    error.statusCode = response.status;
    error.code = payload?.code;
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 额外查询参数（period、studentId 这类非通用参数）由调用方通过 meta.query 传。 */
type ExtraQuery = Record<string, string | number | undefined | null>;

function buildQuery(
  pagination?: { current?: number; pageSize?: number },
  filters?: CrudFilters,
  sorters?: CrudSort[],
  extra?: ExtraQuery,
): string {
  const query = new URLSearchParams();
  query.set('page', String(pagination?.current ?? 1));
  query.set('pageSize', String(pagination?.pageSize ?? 20));

  for (const filter of filters ?? []) {
    if ('field' in filter && filter.value !== undefined && filter.value !== '') {
      query.set(String(filter.field), String(filter.value));
    }
  }
  // 排序：后端目前只支持单字段，取第一个
  const first = (sorters ?? [])[0];
  if (first && 'field' in first) {
    query.set('sortBy', String(first.field));
    query.set('order', first.order === 'desc' ? 'desc' : 'asc');
  }

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

function toListResponse<T>(json: unknown): { data: T[]; total: number } {
  // 有些列表接口不分页，直接返回数组
  if (Array.isArray(json)) return { data: json as T[], total: json.length };
  const paginated = json as Paginated<T>;
  return { data: paginated.items, total: paginated.total };
}

export const dataProvider: DataProvider = {
  getApiUrl: () => API_URL,

  getList: async <TData extends BaseRecord = BaseRecord>({ resource, pagination, filters, sorters, meta }: GetListParams) => {
    const query = buildQuery(pagination, filters, sorters, meta?.query as ExtraQuery);
    const json = await request<unknown>('GET', `/${resource}?${query}`);
    return toListResponse<TData>(json);
  },

  getMany: async <TData extends BaseRecord = BaseRecord>({ resource, ids }: GetManyParams) => {
    const rows = await Promise.all(
      ids.map((id: BaseKey) => request<TData>('GET', `/${resource}/${id}`)),
    );
    return { data: rows };
  },

  getOne: async <TData extends BaseRecord = BaseRecord>({ resource, id }: GetOneParams) => ({
    data: await request<TData>('GET', `/${resource}/${id}`),
  }),

  create: async <TData extends BaseRecord = BaseRecord, TVariables = Record<string, unknown>>({ resource, variables }: CreateParams<TVariables>) => ({
    data: await request<TData>('POST', `/${resource}`, variables),
  }),

  createMany: async <TData extends BaseRecord = BaseRecord, TVariables = Record<string, unknown>>({ resource, variables }: CreateManyParams<TVariables>) => {
    const rows = await Promise.all(
      variables.map((item) => request<TData>('POST', `/${resource}`, item)),
    );
    return { data: rows };
  },

  update: async <TData extends BaseRecord = BaseRecord, TVariables = Record<string, unknown>>({ resource, id, variables }: UpdateParams<TVariables>) => ({
    data: await request<TData>('PATCH', `/${resource}/${id}`, variables),
  }),

  updateMany: async <TData extends BaseRecord = BaseRecord, TVariables = Record<string, unknown>>({ resource, ids, variables }: UpdateManyParams<TVariables>) => {
    // 我们的后端没有批量更新接口；多个 id 就逐个 PATCH
    const target: BaseKey[] = ids;
    const rows = await Promise.all(
      target.map((one) => request<TData>('PATCH', `/${resource}/${one}`, variables)),
    );
    return { data: rows };
  },

  deleteOne: async <TData extends BaseRecord = BaseRecord, TVariables = Record<string, unknown>>({ resource, id }: DeleteOneParams<TVariables>) => ({
    data: await request<TData>('DELETE', `/${resource}/${id}`),
  }),

  deleteMany: async <TData extends BaseRecord = BaseRecord, TVariables = Record<string, unknown>>({ resource, ids }: DeleteManyParams<TVariables>) => {
    // 我们的后端没有批量删除接口；多个 id 就逐个 DELETE
    const target: BaseKey[] = ids;
    const rows = await Promise.all(
      target.map((one) => request<TData>('DELETE', `/${resource}/${one}`)),
    );
    return { data: rows };
  },

  /** 报表类数据（总览、收支、工资）走这里：custom({ url: '/overview?period=2026-10', method: 'get' }) */
  custom: async <TData extends BaseRecord = BaseRecord>({ url, method, payload }: CustomParams) => ({
    data: await request<TData>(method.toUpperCase(), url, payload),
  }),
};
