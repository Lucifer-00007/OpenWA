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
import { AutomationService, SelectedAutomationRule } from './automation.service';
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
  isBusiness?: boolean;
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

type SendTextFn = (chatId: string, text: string) => Promise<AutomationSendResult>;

// ── Queue & Chat State ──────────────────────────

interface QueuedMessage {
  sessionId: string;
  message: AutomationIncomingMessage;
  selected: SelectedAutomationRule;
  incomingMessageHash: string;
  sendText: SendTextFn;
}

type ChatProcessingMode = 'concurrent' | 'sequential';

interface ChatState {
  mode: ChatProcessingMode;
  inflightCount: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  queue: QueuedMessage[];
  draining: boolean;
}

// ── Tuning Constants ────────────────────────────

/** Max queued messages per chat before new messages are rejected. */
const MAX_QUEUE_DEPTH_PER_CHAT = 500;

/** Sliding-window rate limit: max replies a session can send per minute. */
const MAX_REPLIES_PER_MINUTE = 30;

/** Consecutive transient failures before a chat degrades to sequential. */
const DEGRADATION_THRESHOLD = 3;

/** Consecutive successes in sequential mode before restoring concurrent. */
const RECOVERY_THRESHOLD = 5;

/** Max retries for a single send attempt (excludes the initial attempt). */
const MAX_SEND_RETRIES = 2;

/** Backoff delays (ms) between send retries. Index = retry attempt (0-based). */
const SEND_RETRY_DELAYS_MS = [1000, 3000];

const CONTACT_JID_PATTERN = /^[1-9]\d{5,14}@c\.us$/;

@Injectable()
export class AutomationRouterService {
  private readonly logger = createLogger('AutomationRouterService');

  /** Timestamp (epoch ms) when this service instance was created. */
  private readonly startupTimestamp = Date.now();

  /** Hashes currently being processed — fast-path dedup before hitting the DB. */
  private readonly inflightHashes = new Set<string>();

  /** Per-chat processing state (concurrent vs sequential, queue, counters). */
  private readonly chatStates = new Map<string, ChatState>();

  /** Per-session sliding-window of reply timestamps for rate limiting. */
  private readonly sessionReplyTimestamps = new Map<string, number[]>();

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

  // ── Public Entry Point ────────────────────────

  async processIncoming(
    sessionId: string,
    message: AutomationIncomingMessage,
    sendText: SendTextFn,
  ): Promise<void> {
    // Pre-match skip (fromMe, automation echo, empty body)
    const skipReason = this.getPreMatchSkipReason(message);
    if (skipReason) {
      this.logger.debug('Automation message skipped before rule matching', {
        sessionId, reason: skipReason, chatId: message.chatId, senderId: message.from, messageId: message.id,
      });
      return;
    }

    // Startup scoping: skip messages already answered before this restart
    if (await this.isStaleMessage(sessionId, message)) {
      this.logger.debug('Stale message skipped (answered before startup)', {
        sessionId, chatId: message.chatId, messageId: message.id,
      });
      return;
    }

    // Match automation rules
    const rules = await this.automationService.getActiveRulesForSession(sessionId);
    const incomingMessageHash = this.hashIncoming(sessionId, message);
    const selected = this.automationService.selectMatchingRule(rules, message);

    if (!selected) {
      this.logger.debug('No automation rule matched incoming message', {
        sessionId, chatId: message.chatId, senderId: message.from,
        messageId: message.id, contactIds: message.contactIds,
      });
      return;
    }

    // In-flight dedup (fast-path before DB)
    const dedupKey = `${selected.rule.id}:${sessionId}:${incomingMessageHash}`;
    if (this.inflightHashes.has(dedupKey)) {
      this.logger.debug('In-flight duplicate skipped', { sessionId, chatId: message.chatId, messageId: message.id });
      return;
    }

    // DB dedup
    const duplicate = await this.runRepository.findOne({
      where: { ruleId: selected.rule.id, sessionId, incomingMessageHash },
    });
    if (duplicate) {
      this.logger.debug('Duplicate automation message skipped', {
        sessionId, ruleId: selected.rule.id, runId: duplicate.id, chatId: message.chatId, messageId: message.id,
      });
      return;
    }

    // Session rate limit
    if (this.isSessionRateLimited(sessionId)) {
      await this.createRun(selected.rule, message, incomingMessageHash, AutomationRunStatus.RATE_LIMITED, {
        matchedTriggerId: selected.match.trigger?.id,
      });
      this.logger.warn('Session rate limited, reply skipped', { sessionId, chatId: message.chatId });
      return;
    }

    // Per-chat state
    const chatKey = `${sessionId}:${message.chatId}`;
    const state = this.getOrCreateChatState(chatKey);

    // Queue depth guard (only applies in sequential mode where a queue exists)
    if (state.mode === 'sequential' && state.queue.length >= MAX_QUEUE_DEPTH_PER_CHAT) {
      await this.createRun(selected.rule, message, incomingMessageHash, AutomationRunStatus.QUEUE_FULL, {
        matchedTriggerId: selected.match.trigger?.id,
      });
      this.logger.warn('Queue full for chat', { sessionId, chatId: message.chatId, depth: state.queue.length });
      return;
    }

    // Route: concurrent (default) or sequential (degraded)
    this.inflightHashes.add(dedupKey);

    if (state.mode === 'concurrent') {
      state.inflightCount++;
      try {
        await this.executeReply(sessionId, message, selected, incomingMessageHash, sendText);
        this.onReplySuccess(state, chatKey);
      } catch (error) {
        if (this.isTransientError(error)) this.degradeIfNeeded(state, chatKey);
      } finally {
        state.inflightCount--;
        this.inflightHashes.delete(dedupKey);
        this.cleanupIdleChatState(chatKey, state);
      }
    } else {
      // Sequential: enqueue and let the drain loop handle it
      state.queue.push({ sessionId, message, selected, incomingMessageHash, sendText });
      void this.drainQueue(chatKey, state);
    }
  }

  // ── Reply Execution (shared by both paths) ────

  private async executeReply(
    sessionId: string,
    message: AutomationIncomingMessage,
    selected: SelectedAutomationRule,
    incomingMessageHash: string,
    sendText: SendTextFn,
  ): Promise<void> {
    const { rule, match } = selected;

    // Cooldown check
    const cooldownSince = new Date(Date.now() - rule.cooldownSeconds * 1000);
    const cooldown = await this.runRepository.findOne({
      where: {
        ruleId: rule.id, sessionId, chatId: message.chatId,
        status: AutomationRunStatus.SENT, createdAt: MoreThan(cooldownSince),
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
      sessionId, ruleId: rule.id, runId: run.id,
      incomingChatId: message.chatId, senderId: message.from,
      preferredReplyChatId, contactIds: message.contactIds,
      isGroup: message.isGroup, action: 'automation_reply_destination_resolved',
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

      const { result, chatId: sentChatId } = await this.sendWithRetry(
        sendText, preferredReplyChatId, message.chatId,
        replyText.slice(0, 4096), { sessionId, ruleId: rule.id, runId: run.id },
      );

      await this.saveOutgoing(sessionId, rule, message, sentChatId, replyText, result);
      await this.runRepository.update(run.id, {
        status: AutomationRunStatus.SENT, replyMessageId: result.id, latencyMs: Date.now() - startedAt,
      });
      await this.updateLastTriggered(rule.id);
      this.recordReplyTimestamp(sessionId);

      this.logger.log('Automation reply sent', {
        sessionId, ruleId: rule.id, runId: run.id, incomingChatId: message.chatId,
        replyChatId: sentChatId, replyMessageId: result.id, ack: result.ack, latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      // Attempt fallback reply
      const fallbackText = rule.fallbackReply?.trim();
      if (fallbackText) {
        try {
          const { result, chatId: sentChatId } = await this.sendWithRetry(
            sendText, preferredReplyChatId, message.chatId,
            fallbackText.slice(0, 4096), { sessionId, ruleId: rule.id, runId: run.id },
          );
          await this.saveOutgoing(sessionId, rule, message, sentChatId, fallbackText, result);
          await this.runRepository.update(run.id, {
            status: AutomationRunStatus.SENT, replyMessageId: result.id, latencyMs: Date.now() - startedAt,
            errorCode: 'fallback_used', errorMessage: error instanceof Error ? error.message : String(error),
          });
          await this.updateLastTriggered(rule.id);
          this.recordReplyTimestamp(sessionId);
          return;
        } catch (fallbackError) {
          error = fallbackError;
        }
      }

      const status =
        error instanceof DOMException && error.name === 'AbortError'
          ? AutomationRunStatus.PROVIDER_TIMEOUT
          : AutomationRunStatus.FAILED;
      await this.runRepository.update(run.id, {
        status, latencyMs: Date.now() - startedAt,
        errorCode: error instanceof Error ? error.name : 'automation_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.logger.warn('Automation reply failed', {
        sessionId, ruleId: rule.id, runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // re-throw so caller can track for degradation
    }
  }

  // ── Send with Retry (exponential backoff) ─────

  private async sendWithRetry(
    sendText: SendTextFn,
    preferredChatId: string,
    originalChatId: string,
    text: string,
    context: { sessionId: string; ruleId: string; runId: string },
  ): Promise<ReplySendResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
      try {
        return await this.sendReplyText(sendText, preferredChatId, originalChatId, text, context);
      } catch (error) {
        lastError = error;
        if (!this.isTransientError(error) || attempt >= MAX_SEND_RETRIES) break;
        const delay = SEND_RETRY_DELAYS_MS[attempt] ?? 3000;
        this.logger.warn(`Send retry ${attempt + 1}/${MAX_SEND_RETRIES}`, {
          ...context, delayMs: delay, error: error instanceof Error ? error.message : String(error),
        });
        await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 500)));
      }
    }
    throw lastError;
  }

  // ── Sequential Queue Drain ────────────────────

  private async drainQueue(chatKey: string, state: ChatState): Promise<void> {
    if (state.draining) return; // another drain loop is already running
    state.draining = true;
    try {
      while (state.queue.length > 0) {
        const entry = state.queue.shift()!;
        const dedupKey = `${entry.selected.rule.id}:${entry.sessionId}:${entry.incomingMessageHash}`;
        try {
          await this.executeReply(
            entry.sessionId, entry.message, entry.selected,
            entry.incomingMessageHash, entry.sendText,
          );
          this.onReplySuccess(state, chatKey);
        } catch (error) {
          if (this.isTransientError(error)) this.degradeIfNeeded(state, chatKey);
        } finally {
          this.inflightHashes.delete(dedupKey);
        }
      }
    } finally {
      state.draining = false;
      this.cleanupIdleChatState(chatKey, state);
    }
  }

  // ── Chat State Management ─────────────────────

  private getOrCreateChatState(chatKey: string): ChatState {
    let state = this.chatStates.get(chatKey);
    if (!state) {
      state = {
        mode: 'concurrent',
        inflightCount: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        queue: [],
        draining: false,
      };
      this.chatStates.set(chatKey, state);
    }
    return state;
  }

  private onReplySuccess(state: ChatState, chatKey: string): void {
    state.consecutiveFailures = 0;
    if (state.mode === 'sequential') {
      state.consecutiveSuccesses++;
      if (state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
        state.mode = 'concurrent';
        state.consecutiveSuccesses = 0;
        this.logger.log('Chat restored to concurrent mode', { chatKey });
      }
    }
  }

  private degradeIfNeeded(state: ChatState, chatKey: string): void {
    state.consecutiveFailures++;
    state.consecutiveSuccesses = 0;
    if (state.mode === 'concurrent' && state.consecutiveFailures >= DEGRADATION_THRESHOLD) {
      state.mode = 'sequential';
      this.logger.warn('Chat degraded to sequential mode', { chatKey, failures: state.consecutiveFailures });
    }
  }

  /** Remove idle chat states to prevent unbounded memory growth. */
  private cleanupIdleChatState(chatKey: string, state: ChatState): void {
    if (state.inflightCount === 0 && state.queue.length === 0 && !state.draining && state.mode === 'concurrent') {
      this.chatStates.delete(chatKey);
    }
  }

  // ── Startup Scoping ───────────────────────────

  /**
   * A message is "stale" if it was sent before this service started AND there is already
   * a successful automation reply in the same chat after the message's timestamp.
   * This prevents re-processing messages that were answered in a previous process lifetime.
   */
  private async isStaleMessage(sessionId: string, message: AutomationIncomingMessage): Promise<boolean> {
    const messageTimestampMs = message.timestamp ? message.timestamp * 1000 : 0;
    // Messages without a timestamp, or sent after startup, are never stale
    if (!messageTimestampMs || messageTimestampMs >= this.startupTimestamp) return false;

    const existingReply = await this.runRepository.findOne({
      where: {
        sessionId, chatId: message.chatId,
        status: AutomationRunStatus.SENT,
        createdAt: MoreThan(new Date(messageTimestampMs)),
      },
      order: { createdAt: 'DESC' },
    });
    return !!existingReply;
  }

  // ── Rate Limiting ─────────────────────────────

  private isSessionRateLimited(sessionId: string): boolean {
    const windowStart = Date.now() - 60_000;
    const timestamps = this.sessionReplyTimestamps.get(sessionId) || [];
    const recent = timestamps.filter(t => t > windowStart);
    this.sessionReplyTimestamps.set(sessionId, recent);
    return recent.length >= MAX_REPLIES_PER_MINUTE;
  }

  private recordReplyTimestamp(sessionId: string): void {
    const timestamps = this.sessionReplyTimestamps.get(sessionId) || [];
    timestamps.push(Date.now());
    this.sessionReplyTimestamps.set(sessionId, timestamps);
  }

  // ── Transient Error Detection ─────────────────

  private isTransientError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    if (/network|timeout|econnreset|econnrefused|socket hang up|epipe|ehostunreach/.test(msg)) return true;
    const httpMatch = msg.match(/http\s*(\d{3})/i);
    if (httpMatch) {
      const code = parseInt(httpMatch[1], 10);
      return code === 408 || code === 429 || code >= 500;
    }
    return false;
  }

  // ── Preserved Private Helpers ─────────────────

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
    sendText: SendTextFn,
    preferredChatId: string,
    originalChatId: string,
    text: string,
    context: { sessionId: string; ruleId: string; runId: string },
  ): Promise<ReplySendResult> {
    this.logger.log('Automation sendText starting', {
      ...context, preferredChatId, originalChatId, textLength: text.length,
      action: 'automation_send_text_start',
    });

    try {
      const result = await sendText(preferredChatId, text);
      this.logger.log('Automation sendText returned', {
        ...context, chatId: preferredChatId, messageId: result.id, timestamp: result.timestamp,
        ack: result.ack, action: 'automation_send_text_result',
      });
      return { result, chatId: preferredChatId };
    } catch (error) {
      if (preferredChatId === originalChatId) throw error;

      this.logger.warn('Automation sendText failed on preferred chat id, retrying original chat id', {
        ...context, preferredChatId, originalChatId,
        error: error instanceof Error ? error.message : String(error),
        action: 'automation_send_text_retry_original_chat',
      });

      const result = await sendText(originalChatId, text);
      this.logger.log('Automation sendText returned from original chat id retry', {
        ...context, chatId: originalChatId, messageId: result.id, timestamp: result.timestamp,
        ack: result.ack, action: 'automation_send_text_retry_result',
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
    if (message.isBusiness) return 'business_account';
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
