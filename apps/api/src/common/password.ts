import { compare, hash } from 'bcrypt';

/**
 * bcrypt 成本因子。10 是常见起点。
 * 调高会让每次登录变慢（这正是它的目的），但也会拖慢批量建账号，别随手改。
 */
export const BCRYPT_ROUNDS = 10;

/**
 * 密码最长 72 字节 —— bcrypt 只看前 72 字节，超出部分被静默丢弃。
 * 不挡住的话会出现「密码后半段随便改都能登录」这种查不出来的怪事。
 */
export const MAX_PASSWORD_BYTES = 72;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  return compare(plain, passwordHash);
}
