import { EventEmitter } from 'events';
import {
  Chat as WWebChat,
  Client,
  Events,
  LocalAuth,
  Message as WWebMessage,
  MessageMedia,
  type MessageContent,
  type MessageSendOptions,
} from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import {
  GroupChat,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
} from '../types/whatsapp-web-js.types';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

type InjectableWhatsAppClient = Client & {
  inject?: () => Promise<void>;
};

type WhatsAppRuntimePage = {
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>;
};

type WhatsAppRuntimeClient = Client & {
  pupPage?: WhatsAppRuntimePage;
};

type WhatsAppRuntimeConnectionInfo = {
  connected: boolean;
  hasWWebJS: boolean;
  phoneNumber?: string | null;
  pushName?: string | null;
  socketState?: string | null;
};

const RECENT_UNREAD_RECOVERY_WINDOW_SECONDS = 120;
const RECENT_MESSAGE_SCAN_INTERVAL_MS = 5000;
const RECENT_MESSAGE_SCAN_LOOKBACK_SECONDS = 90;
const MAX_RECENT_MESSAGE_SCAN_CHATS = 25;
const MAX_RECENT_MESSAGE_SCAN_MESSAGES_PER_CHAT = 5;
const MAX_RECOVERED_MESSAGES_PER_CHAT = 20;
const MAX_PROCESSED_MESSAGE_IDS = 1000;

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private readyEmitted = false;
  private readyRecoveryTimers: NodeJS.Timeout[] = [];
  private recentMessageScanTimer: NodeJS.Timeout | null = null;
  private recoverySinceTimestamp = 0;
  private readonly processedIncomingMessageIds = new Set<string>();

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.stopRecentMessageScanner();
    this.recoverySinceTimestamp = Math.floor(Date.now() / 1000) - RECENT_UNREAD_RECOVERY_WINDOW_SECONDS;
    this.processedIncomingMessageIds.clear();
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = [
        ...(this.config.puppeteer?.args ?? [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ]),
      ];

      // Add proxy configuration if provided
      if (this.config.proxy) {
        puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
        this.logger.log(
          `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
        );
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          args: puppeteerArgs,
        },
      });

      this.patchClientInjection(this.client);
      this.setupEventHandlers();
      await this.client.initialize();
      this.scheduleReadyRecovery();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  private patchClientInjection(client: Client): void {
    const injectableClient = client as InjectableWhatsAppClient;
    const originalInject = injectableClient.inject?.bind(client);
    if (!originalInject) return;

    injectableClient.inject = async (): Promise<void> => {
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await originalInject();
          await this.patchClientRuntimeCompatibility();
          return;
        } catch (error) {
          if (!this.isNavigationRaceError(error)) {
            throw error;
          }

          const errorMessage = error instanceof Error ? error.message : String(error);
          const canRetry = attempt < maxAttempts;
          this.logger.warn('WhatsApp Web injection raced with page navigation', {
            sessionId: this.config.sessionId,
            attempt,
            maxAttempts,
            retrying: canRetry,
            error: errorMessage,
            action: 'client_inject_navigation_race',
          });

          if (!canRetry) return;
          await this.delay(250 * attempt);
        }
      }
    };
  }

  private async patchClientRuntimeCompatibility(): Promise<void> {
    const runtimeClient = this.client as WhatsAppRuntimeClient | null;
    const page = runtimeClient?.pupPage;
    if (!page) return;

    try {
      await page.evaluate(() => {
        type SendMessageFn = ((...args: unknown[]) => Promise<unknown>) & {
          __openwaCompatPatched?: boolean;
        };

        type WhatsAppBrowserWindow = Window & {
          WWebJS?: {
            sendMessage?: SendMessageFn;
          };
          require?: (moduleName: string) => unknown;
          __openwaSendMessageCompatPatched?: boolean;
        };

        const browserWindow = window as WhatsAppBrowserWindow;

        const originalSendMessage = browserWindow.WWebJS?.sendMessage;
        if (typeof originalSendMessage !== 'function' || originalSendMessage.__openwaCompatPatched) return;

        const patchedSendMessage: SendMessageFn = async function patchedSendMessage(this: unknown, ...args: unknown[]) {
          try {
            const gatingUtils = browserWindow.require?.('WAWebStatusGatingUtils') as
              | {
                  canCheckStatusRankingPosterGating?: () => boolean;
                }
              | undefined;

            if (gatingUtils && typeof gatingUtils.canCheckStatusRankingPosterGating !== 'function') {
              gatingUtils.canCheckStatusRankingPosterGating = () => false;
            }
          } catch {
            // WhatsApp module names change frequently; sendMessage can still work without this guard.
          }

          return originalSendMessage.apply(this, args);
        };

        patchedSendMessage.__openwaCompatPatched = true;
        browserWindow.WWebJS!.sendMessage = patchedSendMessage;
        browserWindow.__openwaSendMessageCompatPatched = true;
      });
    } catch (error) {
      this.logger.debug('Unable to patch WhatsApp Web runtime compatibility', {
        sessionId: this.config.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleReadyRecovery(): void {
    this.clearReadyRecoveryTimers();
    for (const delayMs of [3000, 10000, 30000]) {
      this.readyRecoveryTimers.push(
        setTimeout(() => {
          void this.recoverReadyFromConnectedRuntime();
        }, delayMs),
      );
    }
  }

  private clearReadyRecoveryTimers(): void {
    for (const timer of this.readyRecoveryTimers) {
      clearTimeout(timer);
    }
    this.readyRecoveryTimers = [];
  }

  private async recoverReadyFromConnectedRuntime(): Promise<void> {
    if (this.readyEmitted || this.status === EngineStatus.READY || !this.client) return;

    const runtimeInfo = await this.getRuntimeConnectionInfo();
    if (!runtimeInfo?.connected || !runtimeInfo.hasWWebJS) return;

    this.logger.warn('Recovering WhatsApp ready state from connected runtime', {
      sessionId: this.config.sessionId,
      socketState: runtimeInfo.socketState,
      action: 'ready_state_recovery',
    });

    this.markReady(runtimeInfo.phoneNumber, runtimeInfo.pushName);
  }

  private async getRuntimeConnectionInfo(): Promise<WhatsAppRuntimeConnectionInfo | null> {
    const runtimeClient = this.client as WhatsAppRuntimeClient | null;
    const page = runtimeClient?.pupPage;
    if (!page) return null;

    try {
      return page.evaluate(() => {
        type WhatsAppBrowserWindow = Window & {
          WWebJS?: unknown;
          require?: (moduleName: string) => unknown;
        };
        type WhatsAppWidLike = {
          user?: string;
          _serialized?: string;
          toString?: () => string;
        };
        type WhatsAppConnModel = {
          serialize?: () => {
            pushname?: string;
            pushName?: string;
            wid?: WhatsAppWidLike;
          };
        };

        const browserWindow = window as WhatsAppBrowserWindow;
        const getSerializedUser = (value: unknown): string | null => {
          if (!value) return null;
          if (typeof value === 'string') return value.replace(/@.+$/, '');
          const wid = value as WhatsAppWidLike;
          if (wid.user) return wid.user;
          if (wid._serialized) return wid._serialized.replace(/@.+$/, '');
          const stringValue = wid.toString?.();
          return stringValue && stringValue !== '[object Object]' ? stringValue.replace(/@.+$/, '') : null;
        };

        let socketState: string | null = null;
        let phoneNumber: string | null = null;
        let pushName: string | null = null;

        try {
          socketState = ((browserWindow.require?.('WAWebSocketModel') as { Socket?: { state?: string } } | undefined)
            ?.Socket?.state ?? null) as string | null;
        } catch {
          socketState = null;
        }

        try {
          const conn = browserWindow.require?.('WAWebConnModel') as { Conn?: WhatsAppConnModel } | undefined;
          const serialized = conn?.Conn?.serialize?.();
          phoneNumber = getSerializedUser(serialized?.wid);
          pushName = serialized?.pushname ?? serialized?.pushName ?? null;
        } catch {
          // Runtime module names change frequently; user prefs below is a second source.
        }

        try {
          const userPrefs = browserWindow.require?.('WAWebUserPrefsMeUser') as
            | {
                getMaybeMePnUser?: () => unknown;
                getMaybeMeLidUser?: () => unknown;
              }
            | undefined;
          phoneNumber ||= getSerializedUser(userPrefs?.getMaybeMePnUser?.());
          phoneNumber ||= getSerializedUser(userPrefs?.getMaybeMeLidUser?.());
        } catch {
          // Keep null phone if WhatsApp internals changed.
        }

        return {
          connected: socketState === 'CONNECTED',
          hasWWebJS: typeof browserWindow.WWebJS !== 'undefined',
          phoneNumber,
          pushName,
          socketState,
        };
      });
    } catch (error) {
      this.logger.debug('Unable to inspect WhatsApp Web runtime readiness', {
        sessionId: this.config.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private isNavigationRaceError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('Execution context was destroyed') ||
      message.includes('most likely because of a navigation') ||
      message.includes('Cannot find context with specified id') ||
      message.includes('Navigating frame was detached')
    );
  }

  private isSendMessageCompatibilityError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('canCheckStatusRankingPosterGating is not a function');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      if (this.status !== EngineStatus.READY) {
        this.setStatus(EngineStatus.AUTHENTICATING);
      }
      this.qrCode = null;
    });

    this.client.on('ready', () => {
      try {
        const info = this.client?.info;
        this.markReady(info?.wid?.user, info?.pushname);
      } catch (error) {
        this.logger.error('Error getting client info', String(error));
        this.markReady();
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on(Events.MESSAGE_CREATE, async msg => {
      await this.handleCreatedMessage(msg, 'message_create');
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on(Events.MESSAGE_RECEIVED, async msg => {
      await this.emitIncomingMessage(msg, 'message');
    });

    this.client.on('message_ack', (msg, ack) => {
      this.logger.log('WhatsApp message ACK received', {
        sessionId: this.config.sessionId,
        messageId: msg.id?._serialized,
        chatId: msg.fromMe ? msg.to : msg.from,
        fromMe: msg.fromMe,
        ack,
        action: 'whatsapp_message_ack',
      });
      this.callbacks.onMessageAck?.(msg.id._serialized, ack);
    });

    this.client.on('disconnected', reason => {
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', () => {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onDisconnected?.('Authentication failed');
    });
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === EngineStatus.READY && this.isTransientPreReadyStatus(status)) {
      this.logger.debug('Ignoring stale WhatsApp pre-ready status after ready', {
        sessionId: this.config.sessionId,
        status,
        action: 'stale_status_ignored',
      });
      return;
    }

    this.status = status;
    if (status === EngineStatus.READY) {
      this.clearReadyRecoveryTimers();
    } else {
      this.stopRecentMessageScanner();
    }
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  private isTransientPreReadyStatus(status: EngineStatus): boolean {
    return (
      status === EngineStatus.INITIALIZING || status === EngineStatus.AUTHENTICATING || status === EngineStatus.QR_READY
    );
  }

  private markReady(phoneNumber?: string | null, pushName?: string | null): void {
    if (this.readyEmitted) return;

    this.readyEmitted = true;
    this.qrCode = null;
    this.phoneNumber = phoneNumber || this.phoneNumber || null;
    this.pushName = pushName || this.pushName || null;
    this.setStatus(EngineStatus.READY);
    this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
    void this.recoverRecentUnreadMessages();
    this.startRecentMessageScanner();
  }

  private async handleCreatedMessage(msg: WWebMessage, source: string): Promise<void> {
    if (msg.fromMe) return;
    await this.emitIncomingMessage(msg, source);
  }

  private async emitIncomingMessage(msg: WWebMessage, source: string = 'unknown'): Promise<boolean> {
    if (msg.fromMe) return false;
    if (!this.rememberIncomingMessage(msg.id?._serialized)) return false;

    try {
      const incomingMessage: IncomingMessage = {
        id: msg.id._serialized,
        from: msg.from,
        to: msg.to,
        chatId: msg.from,
        contactIds: await this.resolveMessageContactIds(msg),
        body: msg.body,
        type: msg.type,
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        isGroup: msg.from.endsWith('@g.us'),
      };

      this.logger.log('WhatsApp incoming message normalized', {
        sessionId: this.config.sessionId,
        source,
        messageId: incomingMessage.id,
        from: incomingMessage.from,
        to: incomingMessage.to,
        chatId: incomingMessage.chatId,
        contactIds: incomingMessage.contactIds,
        type: incomingMessage.type,
        bodyLength: incomingMessage.body?.length ?? 0,
        isGroup: incomingMessage.isGroup,
        action: 'whatsapp_incoming_message_normalized',
      });

      // Handle media
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            incomingMessage.media = {
              mimetype: media.mimetype,
              filename: media.filename || undefined,
              data: media.data,
            };
          }
        } catch (error) {
          this.logger.error('Error downloading media', String(error));
        }
      }

      // Handle quoted message
      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          incomingMessage.quotedMessage = {
            id: quoted.id._serialized,
            body: quoted.body,
          };
        } catch (error) {
          this.logger.error('Error getting quoted message', String(error));
        }
      }

      this.callbacks.onMessage?.(incomingMessage);
      return true;
    } catch (error) {
      this.logger.error('Error processing incoming message', String(error));
      return false;
    }
  }

  private async recoverRecentUnreadMessages(): Promise<void> {
    const client = this.client;
    if (!client) return;

    try {
      const chats = (await client.getChats()) as WWebChat[];
      let recoveredCount = 0;

      for (const chat of chats) {
        if (!this.shouldRecoverUnreadChat(chat)) continue;

        const limit = Math.min(Math.max(chat.unreadCount, 1), MAX_RECOVERED_MESSAGES_PER_CHAT);
        const messages = await chat.fetchMessages({ limit });
        for (const msg of messages) {
          if (msg.fromMe || msg.timestamp < this.recoverySinceTimestamp) continue;
          if (await this.emitIncomingMessage(msg, 'recent_unread_recovery')) {
            recoveredCount += 1;
          }
        }
      }

      if (recoveredCount > 0) {
        this.logger.log('Recovered recent unread WhatsApp messages', {
          sessionId: this.config.sessionId,
          count: recoveredCount,
          action: 'recent_unread_recovery',
        });
      }
    } catch (error) {
      this.logger.warn('Recent unread message recovery failed', {
        sessionId: this.config.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startRecentMessageScanner(): void {
    this.stopRecentMessageScanner();
    this.logger.log('WhatsApp recent message scanner started', {
      sessionId: this.config.sessionId,
      intervalMs: RECENT_MESSAGE_SCAN_INTERVAL_MS,
      lookbackSeconds: RECENT_MESSAGE_SCAN_LOOKBACK_SECONDS,
      action: 'recent_message_scanner_started',
    });
    void this.scanRecentMessages();
    this.recentMessageScanTimer = setInterval(() => {
      void this.scanRecentMessages();
    }, RECENT_MESSAGE_SCAN_INTERVAL_MS);
  }

  private stopRecentMessageScanner(): void {
    if (!this.recentMessageScanTimer) return;
    clearInterval(this.recentMessageScanTimer);
    this.recentMessageScanTimer = null;
  }

  private async scanRecentMessages(): Promise<void> {
    const client = this.client;
    if (!client || this.status !== EngineStatus.READY) return;

    const scanSinceTimestamp = Math.floor(Date.now() / 1000) - RECENT_MESSAGE_SCAN_LOOKBACK_SECONDS;

    try {
      const chats = (await client.getChats()) as WWebChat[];
      const recentChats = chats
        .filter(chat => this.shouldScanRecentChat(chat, scanSinceTimestamp))
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, MAX_RECENT_MESSAGE_SCAN_CHATS);
      let recoveredCount = 0;

      for (const chat of recentChats) {
        const unreadCount = Math.max(chat.unreadCount ?? 0, 0);
        const limit = Math.min(Math.max(unreadCount, 1), MAX_RECENT_MESSAGE_SCAN_MESSAGES_PER_CHAT);
        const messages = await chat.fetchMessages({ limit });

        for (const msg of messages) {
          if (msg.fromMe || msg.timestamp < scanSinceTimestamp) continue;
          if (await this.emitIncomingMessage(msg, 'recent_message_scan')) {
            recoveredCount += 1;
          }
        }
      }

      if (recoveredCount > 0) {
        this.logger.log('Recovered recent WhatsApp messages from scan', {
          sessionId: this.config.sessionId,
          count: recoveredCount,
          scannedChats: recentChats.length,
          action: 'recent_message_scan',
        });
      }
    } catch (error) {
      this.logger.warn('Recent WhatsApp message scan failed', {
        sessionId: this.config.sessionId,
        error: error instanceof Error ? error.message : String(error),
        action: 'recent_message_scan_failed',
      });
    }
  }

  private shouldScanRecentChat(chat: WWebChat, scanSinceTimestamp: number): boolean {
    const chatId = chat.id?._serialized;
    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) return false;

    return chat.unreadCount > 0 || chat.timestamp >= scanSinceTimestamp;
  }

  private shouldRecoverUnreadChat(chat: WWebChat): boolean {
    if (chat.unreadCount <= 0) return false;
    const chatId = chat.id?._serialized;
    return Boolean(chatId && chatId !== 'status@broadcast');
  }

  private rememberIncomingMessage(messageId?: string): boolean {
    if (!messageId) return true;
    if (this.processedIncomingMessageIds.has(messageId)) return false;

    this.processedIncomingMessageIds.add(messageId);
    if (this.processedIncomingMessageIds.size > MAX_PROCESSED_MESSAGE_IDS) {
      const oldest = this.processedIncomingMessageIds.values().next().value as string | undefined;
      if (oldest) this.processedIncomingMessageIds.delete(oldest);
    }
    return true;
  }

  async disconnect(): Promise<void> {
    this.clearReadyRecoveryTimers();
    this.stopRecentMessageScanner();
    this.readyEmitted = false;
    if (this.client) {
      try {
        // Use destroy instead of logout to preserve session data
        // This allows reconnecting without needing to scan QR again
        await this.client.destroy();
      } catch (error) {
        this.logger.warn('Destroy client failed:', String(error));
        // Already destroyed or not initialized - ignore
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    this.clearReadyRecoveryTimers();
    this.stopRecentMessageScanner();
    this.readyEmitted = false;
    if (this.client) {
      try {
        // Logout clears session data - user will need to scan QR again
        await this.client.logout();
      } catch (error) {
        this.logger.warn('Logout failed:', String(error));
        // Fall back to destroy if logout fails
        try {
          await this.client.destroy();
        } catch (destroyError) {
          this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
        }
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async destroy(): Promise<void> {
    this.clearReadyRecoveryTimers();
    this.stopRecentMessageScanner();
    this.readyEmitted = false;
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  private async resolveMessageContactIds(msg: WWebMessage): Promise<string[]> {
    const ids = new Set<string>();
    const addId = (id?: string | null): void => {
      if (id?.trim()) ids.add(id.trim().toLowerCase());
    };

    addId(msg.from);
    addId(msg.author);

    try {
      const contact = await msg.getContact();
      addId(contact.id?._serialized);
      if (contact.number) addId(`${contact.number}@c.us`);
    } catch (error) {
      this.logger.debug('Unable to resolve message contact details', {
        messageId: msg.id?._serialized,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const client = this.client as BusinessClient | null;
    if (client?.getContactLidAndPhone && ids.size > 0) {
      try {
        const resolvedIds = await client.getContactLidAndPhone([...ids]);
        for (const resolved of resolvedIds) {
          addId(resolved.lid);
          addId(resolved.pn);
        }
      } catch (error) {
        this.logger.debug('Unable to resolve LID and phone identifiers', {
          messageId: msg.id?._serialized,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return [...ids];
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    this.logger.log('WhatsApp sendTextMessage starting', {
      sessionId: this.config.sessionId,
      chatId,
      textLength: text.length,
      action: 'whatsapp_send_text_start',
    });
    const msg = await this.sendMessageWithCompatibilityRetry(chatId, text);
    this.logger.log('WhatsApp sendTextMessage returned', {
      sessionId: this.config.sessionId,
      chatId,
      messageId: msg.id?._serialized,
      timestamp: msg.timestamp,
      ack: msg.ack,
      from: msg.from,
      to: msg.to,
      fromMe: msg.fromMe,
      action: 'whatsapp_send_text_result',
    });
    const result: MessageResult = {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
    if (msg.ack !== undefined) result.ack = msg.ack;
    return result;
  }

  private async sendMessageWithCompatibilityRetry(
    chatId: string,
    content: MessageContent,
    options?: MessageSendOptions,
  ): Promise<WWebMessage> {
    try {
      return await this.client!.sendMessage(chatId, content, options);
    } catch (error) {
      if (!this.isSendMessageCompatibilityError(error)) {
        throw error;
      }

      this.logger.warn('WhatsApp Web sendMessage compatibility patch required', {
        sessionId: this.config.sessionId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.patchClientRuntimeCompatibility();
      return this.client!.sendMessage(chatId, content, options);
    }
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.sendMessageWithCompatibilityRetry(chatId, messageMedia, {
      caption: media.caption,
    });

    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = await this.client!.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    return numberId !== null;
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const chats = await this.client!.getChats();

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    return groups.map(g => {
      const groupChat = g as unknown as GroupChat;
      return {
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(
          p => p.isAdmin && p.id._serialized === this.client?.info?.wid?._serialized,
        ),
      };
    });
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const { Location } = await import('whatsapp-web.js');
    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.sendMessageWithCompatibilityRetry(chatId, loc);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const msg = await this.sendMessageWithCompatibilityRetry(chatId, vcard, {
      parseVCards: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.sendMessageWithCompatibilityRetry(chatId, messageMedia, {
      sendMediaAsSticker: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    // Find the message to quote
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    const msg = await quotedMsg.reply(text);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const chat = await this.client!.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await msgToForward.forward(toChatId);
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  // Reactions (Phase 3)
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await (message as MessageWithReactions).react(emoji);
    this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  // Labels (Phase 3) - WhatsApp Business only
  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    const labels = await (this.client as unknown as BusinessClient).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.ensureReady();
    const label = await (this.client as unknown as BusinessClient).getLabelById(labelId);
    if (!label) {
      return null;
    }
    return {
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    };
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const labels = await (chat as unknown as GroupChat).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).addLabel(labelId);
    this.logger.log(`Added label ${labelId} to chat ${chatId}`);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).removeLabel(labelId);
    this.logger.log(`Removed label ${labelId} from chat ${chatId}`);
  }

  // Channels/Newsletter (Phase 3)
  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    const channels = await (this.client as unknown as BusinessClient).getChannels();
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        return null;
      }
      return {
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
        inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
        subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
        verified: ch.verified ? Boolean(ch.verified) : undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to get channel: ${channelId}`, String(error));
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const ch = await (this.client as unknown as BusinessClient).subscribeToChannel(inviteCode);
    this.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);
    return {
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
    };
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await (this.client as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    this.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        throw new Error(`Channel ${channelId} not found`);
      }
      const messages = await ch.fetchMessages({ limit });
      if (!messages) {
        return [];
      }
      return messages.map(msg => ({
        id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),
        body: String(msg.body || ''),
        timestamp: Number(msg.timestamp),
        hasMedia: Boolean(msg.hasMedia),
        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to get channel messages: ${String(error)}`);
      return [];
    }
  }

  // ========== Gap Quick Wins Implementation ==========

  // Delete Message
  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await message.delete(forEveryone);
    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  // Block Contact
  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.block();
    this.logger.log(`Blocked contact ${contactId}`);
  }

  // Unblock Contact
  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.unblock();
    this.logger.log(`Unblocked contact ${contactId}`);
  }

  // Get Group Invite Code
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  // Revoke Group Invite Code
  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    // whatsapp-web.js has limited Status API support
    // This is a stub that can be enhanced when the library adds support
    this.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.ensureReady();
    this.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');
    return [];
  }

  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native status posting
    // This would require using the underlying WhatsApp Web API directly
    throw new Error('postTextStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postImageStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postVideoStatus not yet implemented in whatsapp-web.js adapter');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    this.ensureReady();
    throw new Error('deleteStatus not yet implemented in whatsapp-web.js adapter');
  }

  // ========== Catalog (Phase 3) ==========

  async getCatalog(): Promise<Catalog | null> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native Catalog API support
    this.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ensureReady();
    this.logger.warn('getProducts not implemented in whatsapp-web.js adapter');
    return {
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.ensureReady();
    this.logger.warn('getProduct not implemented in whatsapp-web.js adapter');
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendProduct not yet implemented in whatsapp-web.js adapter');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendCatalog not yet implemented in whatsapp-web.js adapter');
  }

  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      throw new Error('WhatsApp client is not ready');
    }
  }
}
