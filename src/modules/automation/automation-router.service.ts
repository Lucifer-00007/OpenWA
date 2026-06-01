import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { MoreThan, Repository } from 'typeorm';
import {
  AutomationMode,
  AutomationRun,
  AutomationRunStatus,
  AutomationRule,
  Message,
  MessageDirection,
  MessageStatus,
  Session,
} from './router.types';
import { AutomationService } from './automation.service';
import { AiProviderService } from './ai-provider.service';
import { createLogger } from '../../common/services/logger.service';

export interface AutomationIncomingMessage {
  id?: string;
  from: string;
  to?: string;
  chatId: string;
  contactIds?: string[];
  body?: string;
  type?: string;
  timestamp?: number;
  fromMe?: boolean;
  isGroup?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AutomationSendResult {
  id: string;
  timestamp: number;
  ack?: number;
}

type ReplySendResult = {
  result: AutomationSendResult;
  chatId: string;
};

const CONTACT_JID_PATTERN = /^[1-9]\d{5,14}@c\.us$/;

@Injectable()
export class AutomationRouterService {
  private readonly logger = createLogger('AutomationRouterService');

  constructor(
    private readonly automationService: AutomationService,
    private readonly aiProviderService: AiProviderService,
    @InjectRepository(AutomationRun, 'data')
    private readonly runRepository: Repository<AutomationRun>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
  ) {}

  async processIncoming(
    sessionId: string,
    message: AutomationIncomingMessage,
    sendText: (chatId: string, text: string) => Promise<AutomationSendResult>,
  ): Promise<void> {
    const skipReason = this.getPreMatchSkipReason(message);
    if (skipReason) {
      this.logger.debug('Automation message skipped before rule matching', {
        sessionId,
        reason: skipReason,
        chatId: message.chatId,
        senderId: message.from,
        messageId: message.id,
      });
      return;
    }

    const rules = await this.automationService.getActiveRulesForSession(sessionId);
    const incomingMessageHash = this.hashIncoming(sessionId, message);
    const selected = this.automationService.selectMatchingRule(rules, message);

    if (!selected) {
      this.logger.debug('No automation rule matched incoming message', {
        sessionId,
        chatId: message.chatId,
        senderId: message.from,
        messageId: message.id,
        contactIds: message.contactIds,
      });
      return;
    }

    const { rule, match } = selected;

    const duplicate = await this.runRepository.findOne({ where: { ruleId: rule.id, sessionId, incomingMessageHash } });
    if (duplicate) {
      this.logger.debug('Duplicate automation message skipped', {
        sessionId,
        ruleId: rule.id,
        runId: duplicate.id,
        chatId: message.chatId,
        messageId: message.id,
      });
      return;
    }

    const cooldownSince = new Date(Date.now() - rule.cooldownSeconds * 1000);
    const cooldown = await this.runRepository.findOne({
      where: {
        ruleId: rule.id,
        sessionId,
        chatId: message.chatId,
        status: AutomationRunStatus.SENT,
        createdAt: MoreThan(cooldownSince),
      },
    });
    if (cooldown) {
      await this.createRun(rule, message, incomingMessageHash, AutomationRunStatus.COOLDOWN, {
        matchedTriggerId: match.trigger?.id,
      });
      return;
    }

    const run = await this.createRun(rule, message, incomingMessageHash, AutomationRunStatus.MATCHED, {
      matchedTriggerId: match.trigger?.id,
    });
    const preferredReplyChatId = this.getPreferredReplyChatId(message);

    this.logger.log('Automation reply destination resolved', {
      sessionId,
      ruleId: rule.id,
      runId: run.id,
      incomingChatId: message.chatId,
      senderId: message.from,
      preferredReplyChatId,
      contactIds: message.contactIds,
      isGroup: message.isGroup,
      action: 'automation_reply_destination_resolved',
    });

    const startedAt = Date.now();
    try {
      let replyText = match.replyText;
      if (rule.mode === AutomationMode.AI) {
        replyText = await this.generateAiReply(rule, message);
      }
      if (!replyText?.trim()) throw new Error('Automation generated an empty reply');
      if (rule.replyDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, rule.replyDelayMs));
      }
      const { result, chatId: sentChatId } = await this.sendReplyText(
        sendText,
        preferredReplyChatId,
        message.chatId,
        replyText.slice(0, 4096),
        {
          sessionId,
          ruleId: rule.id,
          runId: run.id,
        },
      );
      await this.saveOutgoing(sessionId, rule, message, sentChatId, replyText, result);
      await this.runRepository.update(run.id, {
        status: AutomationRunStatus.SENT,
        replyMessageId: result.id,
        latencyMs: Date.now() - startedAt,
      });
      await this.updateLastTriggered(rule.id);
      this.logger.log('Automation reply sent', {
        sessionId,
        ruleId: rule.id,
        runId: run.id,
        incomingChatId: message.chatId,
        replyChatId: sentChatId,
        replyMessageId: result.id,
        ack: result.ack,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const fallbackReply = rule.fallbackReply?.trim();
      if (fallbackReply) {
        try {
          const { result, chatId: sentChatId } = await this.sendReplyText(
            sendText,
            preferredReplyChatId,
            message.chatId,
            fallbackReply.slice(0, 4096),
            {
              sessionId,
              ruleId: rule.id,
              runId: run.id,
            },
          );
          await this.saveOutgoing(sessionId, rule, message, sentChatId, fallbackReply, result);
          await this.runRepository.update(run.id, {
            status: AutomationRunStatus.SENT,
            replyMessageId: result.id,
            latencyMs: Date.now() - startedAt,
            errorCode: 'fallback_used',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          await this.updateLastTriggered(rule.id);
          return;
        } catch (fallbackError) {
          error = fallbackError;
        }
      }
      await this.runRepository.update(run.id, {
        status:
          error instanceof DOMException && error.name === 'AbortError'
            ? AutomationRunStatus.PROVIDER_TIMEOUT
            : AutomationRunStatus.FAILED,
        latencyMs: Date.now() - startedAt,
        errorCode: error instanceof Error ? error.name : 'automation_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.logger.warn('Automation reply failed', {
        sessionId,
        ruleId: rule.id,
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async generateAiReply(rule: AutomationRule, message: AutomationIncomingMessage): Promise<string> {
    if (!rule.provider) throw new Error('AI provider not found');
    return this.aiProviderService.complete(rule.provider, {
      model: rule.model,
      systemPrompt: rule.systemPrompt,
      userPrompt: this.automationService.renderPrompt(rule, {
        body: message.body,
        chatId: message.chatId,
        from: message.from,
        contactIds: message.contactIds,
        sessionId: rule.sessionId,
        isGroup: message.isGroup,
      }),
      temperature: rule.temperature,
      maxTokens: rule.maxTokens,
    });
  }

  private async createRun(
    rule: AutomationRule,
    message: AutomationIncomingMessage,
    incomingMessageHash: string,
    status: AutomationRunStatus,
    options: { matchedTriggerId?: string | null } = {},
  ): Promise<AutomationRun> {
    const run = this.runRepository.create({
      ruleId: rule.id,
      sessionId: rule.sessionId,
      incomingMessageId: message.id ?? null,
      incomingMessageHash,
      chatId: message.chatId,
      senderId: message.from,
      mode: rule.mode,
      status,
      matchedTriggerId: options.matchedTriggerId ?? null,
      providerId: rule.providerId,
    });
    return this.runRepository.save(run);
  }

  private async saveOutgoing(
    sessionId: string,
    rule: AutomationRule,
    incoming: AutomationIncomingMessage,
    replyChatId: string,
    replyText: string,
    result: AutomationSendResult,
  ): Promise<void> {
    const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
    const message = this.messageRepository.create({
      sessionId,
      waMessageId: result.id,
      chatId: replyChatId,
      from: session?.phone || 'me',
      to: replyChatId,
      body: replyText,
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: result.timestamp,
      status: MessageStatus.SENT,
      metadata: {
        automation: true,
        automationRuleId: rule.id,
        incomingMessageId: incoming.id,
        incomingChatId: incoming.chatId,
        replyChatId,
      },
    });
    await this.messageRepository.save(message);
  }

  private async sendReplyText(
    sendText: (chatId: string, text: string) => Promise<AutomationSendResult>,
    preferredChatId: string,
    originalChatId: string,
    text: string,
    context: { sessionId: string; ruleId: string; runId: string },
  ): Promise<ReplySendResult> {
    this.logger.log('Automation sendText starting', {
      ...context,
      preferredChatId,
      originalChatId,
      textLength: text.length,
      action: 'automation_send_text_start',
    });

    try {
      const result = await sendText(preferredChatId, text);
      this.logger.log('Automation sendText returned', {
        ...context,
        chatId: preferredChatId,
        messageId: result.id,
        timestamp: result.timestamp,
        ack: result.ack,
        action: 'automation_send_text_result',
      });
      return { result, chatId: preferredChatId };
    } catch (error) {
      if (preferredChatId === originalChatId) throw error;

      this.logger.warn('Automation sendText failed on preferred chat id, retrying original chat id', {
        ...context,
        preferredChatId,
        originalChatId,
        error: error instanceof Error ? error.message : String(error),
        action: 'automation_send_text_retry_original_chat',
      });

      const result = await sendText(originalChatId, text);
      this.logger.log('Automation sendText returned from original chat id retry', {
        ...context,
        chatId: originalChatId,
        messageId: result.id,
        timestamp: result.timestamp,
        ack: result.ack,
        action: 'automation_send_text_retry_result',
      });
      return { result, chatId: originalChatId };
    }
  }

  private getPreferredReplyChatId(message: AutomationIncomingMessage): string {
    if (message.isGroup || message.chatId.endsWith('@g.us')) return message.chatId;

    const phoneChatId = [message.from, message.chatId, ...(message.contactIds || [])]
      .map(value => this.normalizeContactCandidate(value))
      .find((value): value is string => Boolean(value && CONTACT_JID_PATTERN.test(value)));

    return phoneChatId || message.chatId;
  }

  private normalizeContactCandidate(value?: string | null): string | null {
    const trimmed = value?.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed.endsWith('@lid')) return trimmed;
    const address = trimmed.replace(/@(c\.us|s\.whatsapp\.net)$/i, '');
    const digits = address.replace(/[^\d]/g, '');
    return digits ? `${digits}@c.us` : trimmed;
  }

  private updateLastTriggered(ruleId: string): Promise<unknown> {
    return this.runRepository.manager.getRepository(AutomationRule).update(ruleId, { lastTriggeredAt: new Date() });
  }

  private getPreMatchSkipReason(message: AutomationIncomingMessage): string | null {
    if (message.fromMe) return 'from_me';
    if ((message.metadata as { automation?: boolean } | undefined)?.automation) return 'automation_message';
    if (!message.body?.trim()) return 'empty_body';
    return null;
  }

  private hashIncoming(sessionId: string, message: AutomationIncomingMessage): string {
    const source =
      message.id || `${sessionId}|${message.chatId}|${message.timestamp || ''}|${message.from}|${message.body || ''}`;
    return createHash('sha256').update(source).digest('hex');
  }
}
