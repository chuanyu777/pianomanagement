import { Prisma, type UserRole } from '../../generated/prisma/client.js';

export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  role: true,
  isActive: true,
  teacher: {
    select: {
      id: true,
      name: true,
      isActive: true,
    },
  },
} satisfies Prisma.UserSelect;

export const USER_AUTH_SELECT = {
  ...PUBLIC_USER_SELECT,
  passwordHash: true,
} satisfies Prisma.UserSelect;

export type PublicUser = {
  id: string;
  username: string;
  role: UserRole;
  teacherId?: string;
};

export type AuthenticatedActor = PublicUser;
