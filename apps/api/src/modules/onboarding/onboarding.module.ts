import { Module } from '@nestjs/common';
import { ItemsModule } from '../items/items.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { OnboardingController } from './onboarding.controller.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * 初始化向导（US-IW-01 / US-IW-02）。
 *
 * 编排已有的权威 service：机构三值走 OrganizationService，默认收支项目走 ItemsService.seedDefaults。
 * 不自己重写这两块口径。
 */
@Module({
  imports: [OrganizationModule, ItemsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
