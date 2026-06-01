import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AutomationProvider,
  AutomationRule,
  AutomationRun,
  AutomationTarget,
  AutomationTrigger,
} from './entities';
import { Message } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { AutomationController } from './automation.controller';
import { AutomationProviderController } from './automation-provider.controller';
import { AutomationService } from './automation.service';
import { AiProviderService } from './ai-provider.service';
import { AutomationCryptoService } from './automation-crypto.service';
import { AutomationRouterService } from './automation-router.service';

@Module({
  imports: [
    TypeOrmModule.forFeature(
      [AutomationProvider, AutomationRule, AutomationTarget, AutomationTrigger, AutomationRun, Message, Session],
      'data',
    ),
  ],
  controllers: [AutomationController, AutomationProviderController],
  providers: [AutomationService, AiProviderService, AutomationCryptoService, AutomationRouterService],
  exports: [AutomationRouterService],
})
export class AutomationModule {}
