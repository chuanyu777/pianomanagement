import { SetMetadata } from '@nestjs/common';

export const CAPABILITY_PERMISSION = 'piano:capability-permission';
export type CapabilityPermission = 'READ' | 'PREVIEW_L1' | 'PREVIEW_L2';

export const RequiresCapability = (permission: CapabilityPermission) =>
  SetMetadata(CAPABILITY_PERMISSION, permission);
