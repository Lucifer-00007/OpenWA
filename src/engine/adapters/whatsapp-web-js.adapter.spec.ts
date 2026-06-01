import { Client, Events } from 'whatsapp-web.js';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

describe('WhatsAppWebJsAdapter', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function createAdapter(): WhatsAppWebJsAdapter {
    return new WhatsAppWebJsAdapter({
      sessionId: 'test-session',
      sessionDataPath: './data/sessions',
    });
  }

  it('retries transient injection errors caused by navigation races', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const adapter = createAdapter();
    const patchSpy = jest
      .spyOn(
        adapter as unknown as {
          patchClientRuntimeCompatibility: () => Promise<void>;
        },
        'patchClientRuntimeCompatibility',
      )
      .mockResolvedValue(undefined);
    const originalInject = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.'))
      .mockResolvedValueOnce(undefined);
    const client = { inject: originalInject } as unknown as Client;

    (
      adapter as unknown as {
        patchClientInjection: (client: Client) => void;
      }
    ).patchClientInjection(client);

    const injectPromise = (client as unknown as { inject: () => Promise<void> }).inject();
    await jest.advanceTimersByTimeAsync(250);
    await injectPromise;

    expect(originalInject).toHaveBeenCalledTimes(2);
    expect(patchSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('does not swallow non-navigation injection errors', async () => {
    const adapter = createAdapter();
    const error = new Error('Store injection failed');
    const originalInject = jest.fn<Promise<void>, []>().mockRejectedValue(error);
    const client = { inject: originalInject } as unknown as Client;

    (
      adapter as unknown as {
        patchClientInjection: (client: Client) => void;
      }
    ).patchClientInjection(client);

    await expect((client as unknown as { inject: () => Promise<void> }).inject()).rejects.toThrow(error);
    expect(originalInject).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade READY status when a stale authenticating event arrives', () => {
    const adapter = createAdapter();
    const setStatus = (adapter as unknown as { setStatus: (status: EngineStatus) => void }).setStatus.bind(adapter);

    setStatus(EngineStatus.READY);
    setStatus(EngineStatus.AUTHENTICATING);

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
  });

  it('recovers READY status when an already-linked runtime is connected', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = createAdapter();
    const onReady = jest.fn();
    const evaluate = jest.fn(async (pageFunction: () => unknown | Promise<unknown>) => {
      const testGlobal = globalThis as unknown as { window?: unknown };
      const previousWindow = testGlobal.window;
      testGlobal.window = {
        WWebJS: {},
        require: jest.fn((moduleName: string): unknown => {
          if (moduleName === 'WAWebSocketModel') return { Socket: { state: 'CONNECTED' } };
          if (moduleName === 'WAWebConnModel') {
            return {
              Conn: {
                serialize: () => ({
                  pushname: 'AP',
                  wid: { user: '918918131603', _serialized: '918918131603@c.us' },
                }),
              },
            };
          }
          return undefined;
        }),
      };
      try {
        return pageFunction();
      } finally {
        if (previousWindow === undefined) {
          delete testGlobal.window;
        } else {
          testGlobal.window = previousWindow;
        }
      }
    });

    const recoverUnreadSpy = jest
      .spyOn(
        adapter as unknown as {
          recoverRecentUnreadMessages: () => Promise<void>;
        },
        'recoverRecentUnreadMessages',
      )
      .mockResolvedValue(undefined);
    const startScannerSpy = jest
      .spyOn(
        adapter as unknown as {
          startRecentMessageScanner: () => void;
        },
        'startRecentMessageScanner',
      )
      .mockImplementation(() => undefined);

    Object.assign(adapter as unknown as { client: unknown; callbacks: unknown; status: EngineStatus }, {
      client: { pupPage: { evaluate } },
      callbacks: { onReady },
      status: EngineStatus.AUTHENTICATING,
    });

    await (
      adapter as unknown as {
        recoverReadyFromConnectedRuntime: () => Promise<void>;
      }
    ).recoverReadyFromConnectedRuntime();

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(adapter.getPhoneNumber()).toBe('918918131603');
    expect(adapter.getPushName()).toBe('AP');
    expect(onReady).toHaveBeenCalledWith('918918131603', 'AP');
    expect(recoverUnreadSpy).toHaveBeenCalledTimes(1);
    expect(startScannerSpy).toHaveBeenCalledTimes(1);
  });

  it('installs a browser runtime fallback for missing WhatsApp status gating', async () => {
    const adapter = createAdapter();
    const gatingUtils: { canCheckStatusRankingPosterGating?: () => boolean } = {};
    const originalSendMessage = jest.fn<Promise<string>, unknown[]>().mockResolvedValue('sent');
    const browserWindow = {
      WWebJS: { sendMessage: originalSendMessage },
      require: jest.fn((moduleName: string): unknown => {
        if (moduleName === 'WAWebStatusGatingUtils') return gatingUtils;
        return undefined;
      }),
    };
    const testGlobal = globalThis as unknown as { window?: unknown };
    const previousWindow = testGlobal.window;
    const evaluate = jest.fn(async (pageFunction: () => unknown | Promise<unknown>) => {
      testGlobal.window = browserWindow;
      try {
        await pageFunction();
      } finally {
        if (previousWindow === undefined) {
          delete testGlobal.window;
        } else {
          testGlobal.window = previousWindow;
        }
      }
    });

    Object.assign(adapter as unknown as { client: unknown }, {
      client: { pupPage: { evaluate } },
    });

    await (
      adapter as unknown as {
        patchClientRuntimeCompatibility: () => Promise<void>;
      }
    ).patchClientRuntimeCompatibility();

    await browserWindow.WWebJS.sendMessage('chat', 'hello');

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(gatingUtils.canCheckStatusRankingPosterGating?.()).toBe(false);
    expect(originalSendMessage).toHaveBeenCalledWith('chat', 'hello');
  });

  it('patches and retries sendMessage when WhatsApp Web status gating is missing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = createAdapter();
    const patchSpy = jest
      .spyOn(
        adapter as unknown as {
          patchClientRuntimeCompatibility: () => Promise<void>;
        },
        'patchClientRuntimeCompatibility',
      )
      .mockResolvedValue(undefined);
    const sendMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('window.require(...).canCheckStatusRankingPosterGating is not a function'))
      .mockResolvedValueOnce({
        id: { _serialized: 'message-1' },
        timestamp: 1717240000,
      });

    Object.assign(adapter as unknown as { client: unknown; status: EngineStatus }, {
      client: { sendMessage },
      status: EngineStatus.READY,
    });

    await expect(adapter.sendTextMessage('123@c.us', 'hello')).resolves.toEqual({
      id: 'message-1',
      timestamp: 1717240000,
    });
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, '123@c.us', 'hello', undefined);
    warnSpy.mockRestore();
  });

  it('subscribes to both WhatsApp message streams and forwards non-self messages once', async () => {
    const adapter = createAdapter();
    const onMessage = jest.fn();
    const handlers = new Map<string, (message: never) => Promise<void> | void>();
    const client = {
      on: jest.fn((event: string, handler: (message: never) => Promise<void> | void) => {
        handlers.set(event, handler);
        return client;
      }),
    };

    Object.assign(
      adapter as unknown as {
        client: unknown;
        callbacks: unknown;
      },
      {
        client,
        callbacks: { onMessage },
      },
    );

    (
      adapter as unknown as {
        setupEventHandlers: () => void;
      }
    ).setupEventHandlers();

    expect(handlers.has(Events.MESSAGE_CREATE)).toBe(true);
    expect(handlers.has(Events.MESSAGE_RECEIVED)).toBe(true);

    const message = {
      id: { _serialized: 'msg-1' },
      from: '120113172881475@lid',
      to: '918918131603@c.us',
      body: 'hello',
      type: 'chat',
      timestamp: 1717240000,
      fromMe: false,
      author: undefined,
      hasMedia: false,
      hasQuotedMsg: false,
      getContact: jest.fn().mockResolvedValue({
        id: { _serialized: '120113172881475@lid' },
        number: '919877073348',
      }),
    } as never;

    await handlers.get(Events.MESSAGE_CREATE)?.(message);
    await handlers.get(Events.MESSAGE_CREATE)?.(message);
    await handlers.get(Events.MESSAGE_RECEIVED)?.(message);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-1',
        from: '120113172881475@lid',
        chatId: '120113172881475@lid',
        contactIds: expect.arrayContaining(['120113172881475@lid', '919877073348@c.us']),
        body: 'hello',
        fromMe: false,
      }),
    );
  });

  it('uses the received-message event as a fallback when message_create does not arrive', async () => {
    const adapter = createAdapter();
    const onMessage = jest.fn();
    const handlers = new Map<string, (message: never) => Promise<void> | void>();
    const client = {
      on: jest.fn((event: string, handler: (message: never) => Promise<void> | void) => {
        handlers.set(event, handler);
        return client;
      }),
    };

    Object.assign(
      adapter as unknown as {
        client: unknown;
        callbacks: unknown;
      },
      {
        client,
        callbacks: { onMessage },
      },
    );

    (
      adapter as unknown as {
        setupEventHandlers: () => void;
      }
    ).setupEventHandlers();

    await handlers.get(Events.MESSAGE_RECEIVED)?.({
      id: { _serialized: 'msg-2' },
      from: '919877073348@c.us',
      to: '918918131603@c.us',
      body: 'hello again',
      type: 'chat',
      timestamp: 1717240001,
      fromMe: false,
      author: undefined,
      hasMedia: false,
      hasQuotedMsg: false,
      getContact: jest.fn().mockResolvedValue({
        id: { _serialized: '919877073348@c.us' },
        number: '919877073348',
      }),
    } as never);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-2',
        from: '919877073348@c.us',
        body: 'hello again',
      }),
    );
  });

  it('scans recent chats for missed inbound messages without duplicating callbacks', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1717240100000);
    const adapter = createAdapter();
    const onMessage = jest.fn();
    const message = {
      id: { _serialized: 'msg-scan-1' },
      from: '120113172881475@lid',
      to: '918918131603@c.us',
      body: 'scan fallback',
      type: 'chat',
      timestamp: 1717240090,
      fromMe: false,
      author: undefined,
      hasMedia: false,
      hasQuotedMsg: false,
      getContact: jest.fn().mockResolvedValue({
        id: { _serialized: '120113172881475@lid' },
        number: '919877073348',
      }),
    } as never;
    const fetchMessages = jest.fn().mockResolvedValue([message]);
    const getChats = jest.fn().mockResolvedValue([
      {
        id: { _serialized: '120113172881475@lid' },
        unreadCount: 0,
        timestamp: 1717240095,
        fetchMessages,
      },
    ]);

    Object.assign(
      adapter as unknown as {
        client: unknown;
        callbacks: unknown;
        status: EngineStatus;
      },
      {
        client: { getChats },
        callbacks: { onMessage },
        status: EngineStatus.READY,
      },
    );

    await (
      adapter as unknown as {
        scanRecentMessages: () => Promise<void>;
      }
    ).scanRecentMessages();
    await (
      adapter as unknown as {
        scanRecentMessages: () => Promise<void>;
      }
    ).scanRecentMessages();

    expect(fetchMessages).toHaveBeenCalledWith({ limit: 1 });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-scan-1',
        from: '120113172881475@lid',
        contactIds: expect.arrayContaining(['120113172881475@lid', '919877073348@c.us']),
        body: 'scan fallback',
      }),
    );
  });

  it('ignores self messages from message_create to prevent automation loops', async () => {
    const adapter = createAdapter();
    const onMessage = jest.fn();

    Object.assign(
      adapter as unknown as {
        callbacks: unknown;
      },
      {
        callbacks: { onMessage },
      },
    );

    await (
      adapter as unknown as {
        handleCreatedMessage: (message: never) => Promise<void>;
      }
    ).handleCreatedMessage({
      id: { _serialized: 'own-msg-1' },
      from: '918918131603@c.us',
      to: '918918131603@c.us',
      body: 'hello',
      type: 'chat',
      timestamp: 1717240000,
      fromMe: true,
      hasMedia: false,
      hasQuotedMsg: false,
    } as never);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('does not retry unrelated sendMessage failures', async () => {
    const adapter = createAdapter();
    const patchSpy = jest
      .spyOn(
        adapter as unknown as {
          patchClientRuntimeCompatibility: () => Promise<void>;
        },
        'patchClientRuntimeCompatibility',
      )
      .mockResolvedValue(undefined);
    const sendError = new Error('Evaluation failed: chat not found');
    const sendMessage = jest.fn().mockRejectedValue(sendError);

    Object.assign(adapter as unknown as { client: unknown; status: EngineStatus }, {
      client: { sendMessage },
      status: EngineStatus.READY,
    });

    await expect(adapter.sendTextMessage('123@c.us', 'hello')).rejects.toThrow(sendError);
    expect(patchSpy).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
