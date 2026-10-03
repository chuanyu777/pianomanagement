import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../prisma/generated.js';

export const ROLES_KEY = 'piano:roles';

/**
 * 声明允许访问的角色。
 *
 * 取值直接来自 Prisma 的 UserRole —— **不要**在这里另抄一份常量表，
 * 抄一份就是「同一规则两份实现」，改了一处忘了另一处会静默放权。
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
