import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { WebhookModule } from '../webhook/webhook.module';
import { AutomationModule } from '../automation/automation.module';

@Module({
  imports: [TypeOrmModule.forFeature([Session], 'data'), forwardRef(() => WebhookModule), AutomationModule],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
