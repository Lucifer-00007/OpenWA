import { AutomationRouterService } from './automation-router.service';
import { AutomationMode, AutomationRunStatus } from './router.types';

// ── Shared test helpers ──────────────────────────

function createRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    sessionId: 'session-1',
    mode: AutomationMode.AI,
    cooldownSeconds: 30,
    replyDelayMs: 0,
    providerId: 'provider-1',
    provider: { id: 'provider-1' },
    fallbackReply: null,
    ...overrides,
  };
}

function createMocks(overrides: {
  duplicateRun?: unknown;
  cooldownRun?: unknown;
  staleRun?: unknown;
  aiReply?: string;
  selectResult?: unknown;
} = {}) {
  const rule = createRule();
  const automationService = {
    getActiveRulesForSession: jest.fn().mockResolvedValue([rule]),
    selectMatchingRule: jest.fn().mockReturnValue(
      overrides.selectResult !== undefined
        ? overrides.selectResult
        : { rule, match: { matched: true, reason: 'ai_scope_match' } },
    ),
    renderPrompt: jest.fn().mockReturnValue('Prompt'),
  };
  const aiProviderService = {
    complete: jest.fn().mockResolvedValue(overrides.aiReply ?? 'Reply'),
  };
  const runRepository = {
    findOne: jest.fn().mockImplementation((opts: { where: Record<string, unknown>; order?: unknown }) => {
      const where = opts.where;
      // Duplicate check: has incomingMessageHash
      if (where.incomingMessageHash) return Promise.resolve(overrides.duplicateRun ?? null);
      // Cooldown check: has ruleId + status SENT + chatId
      if (where.ruleId && where.status === AutomationRunStatus.SENT && where.chatId) {
        return Promise.resolve(overrides.cooldownRun ?? null);
      }
      // Stale check: has status SENT + chatId + createdAt but NO ruleId
      if (!where.ruleId && where.status === AutomationRunStatus.SENT && where.chatId && where.createdAt) {
        return Promise.resolve(overrides.staleRun ?? null);
      }
      return Promise.resolve(null);
    }),
    create: jest.fn().mockImplementation(run => run),
    save: jest.fn().mockImplementation(run => Promise.resolve({ id: 'run-1', ...run })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: {
      getRepository: jest.fn().mockReturnValue({
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      }),
    },
  };
  const messageRepository = {
    create: jest.fn().mockImplementation(message => message),
    save: jest.fn().mockResolvedValue({}),
  };
  const sessionRepository = {
    findOne: jest.fn().mockResolvedValue({ phone: '918918131603' }),
  };

  const service = new AutomationRouterService(
    automationService as never,
    aiProviderService as never,
    runRepository as never,
    messageRepository as never,
    sessionRepository as never,
  );

  return { service, automationService, aiProviderService, runRepository, messageRepository };
}

function incomingMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'incoming-1',
    from: '919877073348@c.us',
    chatId: '919877073348@c.us',
    body: 'hello',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────

describe('AutomationRouterService', () => {
  // --- Existing behavior: dedup ---
  it('skips duplicate incoming messages without inserting another run', async () => {
    const { service, aiProviderService, runRepository, messageRepository } = createMocks({
      duplicateRun: { id: 'existing-run', status: AutomationRunStatus.SENT },
    });
    const sendText = jest.fn().mockResolvedValue({ id: 'reply-1', timestamp: 1717240000 });

    await service.processIncoming('session-1', incomingMessage(), sendText);

    expect(runRepository.create).not.toHaveBeenCalled();
    expect(runRepository.save).not.toHaveBeenCalled();
    expect(aiProviderService.complete).not.toHaveBeenCalled();
    expect(messageRepository.save).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  // --- Existing behavior: LID preferred chat ---
  it('prefers a resolved phone chat id when replying to direct LID messages', async () => {
    const { service, runRepository, messageRepository } = createMocks();
    const sendText = jest.fn().mockResolvedValue({ id: 'reply-1', timestamp: 1717240000, ack: 0 });

    await service.processIncoming(
      'session-1',
      incomingMessage({
        from: '3307695243467@lid',
        chatId: '3307695243467@lid',
        contactIds: ['3307695243467@lid', '919877073348@c.us'],
      }),
      sendText,
    );

    expect(sendText).toHaveBeenCalledWith('919877073348@c.us', 'Reply');
    expect(messageRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '919877073348@c.us',
        to: '919877073348@c.us',
        metadata: expect.objectContaining({
          incomingChatId: '3307695243467@lid',
          replyChatId: '919877073348@c.us',
        }),
      }),
    );
    expect(runRepository.update).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: AutomationRunStatus.SENT,
        replyMessageId: 'reply-1',
      }),
    );
  });

  // --- Startup scoping ---
  it('skips stale messages that were already answered before startup', async () => {
    const { service, aiProviderService, runRepository } = createMocks({
      staleRun: { id: 'old-run', status: AutomationRunStatus.SENT },
    });
    const sendText = jest.fn();

    // Message with a timestamp in the past (before service startup)
    await service.processIncoming(
      'session-1',
      incomingMessage({ timestamp: Math.floor(Date.now() / 1000) - 600 }), // 10 minutes ago
      sendText,
    );

    expect(aiProviderService.complete).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    // Should not create a new run — the message was skipped before matching
    expect(runRepository.create).not.toHaveBeenCalled();
  });

  it('processes messages from after startup normally', async () => {
    const { service, runRepository } = createMocks();
    const sendText = jest.fn().mockResolvedValue({ id: 'reply-1', timestamp: 1717240000 });

    // Message with a timestamp in the future (after startup)
    await service.processIncoming(
      'session-1',
      incomingMessage({ timestamp: Math.floor(Date.now() / 1000) + 60 }), // 1 minute from now
      sendText,
    );

    expect(sendText).toHaveBeenCalled();
    expect(runRepository.update).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: AutomationRunStatus.SENT }),
    );
  });

  it('processes messages without a timestamp (real-time) normally', async () => {
    const { service } = createMocks();
    const sendText = jest.fn().mockResolvedValue({ id: 'reply-1', timestamp: 1717240000 });

    await service.processIncoming('session-1', incomingMessage({ timestamp: undefined }), sendText);

    expect(sendText).toHaveBeenCalled();
  });

  // --- In-flight dedup ---
  it('skips in-flight duplicate when same message is processed concurrently', async () => {
    let resolveFirst: () => void;
    const firstCallBlocked = new Promise<void>(resolve => { resolveFirst = resolve; });
    let callCount = 0;

    const { service } = createMocks();
    const sendText = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call blocks until we release it
        await firstCallBlocked;
      }
      return { id: `reply-${callCount}`, timestamp: 1717240000 };
    });

    const msg = incomingMessage();
    const p1 = service.processIncoming('session-1', msg, sendText);
    // Small delay to ensure first call reaches the inflight check
    await new Promise(resolve => setTimeout(resolve, 10));
    const p2 = service.processIncoming('session-1', msg, sendText);

    resolveFirst!();
    await Promise.all([p1, p2]);

    // Only first call should have sent
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  // --- Rate limiting ---
  it('rate-limits replies beyond MAX_REPLIES_PER_MINUTE', async () => {
    const { service, runRepository } = createMocks();
    const sendText = jest.fn().mockResolvedValue({ id: 'reply', timestamp: 1717240000 });

    // Send messages sequentially so the rate limiter window fills up as replies are recorded
    for (let i = 0; i < 35; i++) {
      await service.processIncoming(
        'session-1',
        incomingMessage({ id: `msg-${i}`, body: `msg ${i}` }),
        sendText,
      );
    }

    // At least one should have been rate limited
    const rateLimitedCalls = runRepository.save.mock.calls.filter(
      (call: unknown[]) => (call[0] as { status: string }).status === AutomationRunStatus.RATE_LIMITED,
    );
    expect(rateLimitedCalls.length).toBeGreaterThanOrEqual(1);
  });

  // --- Send retry ---
  it('retries transient send failures and succeeds on retry', async () => {
    const { service, runRepository } = createMocks();
    let attempt = 0;
    const sendText = jest.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error('network timeout');
      return { id: 'reply-1', timestamp: 1717240000 };
    });

    await service.processIncoming('session-1', incomingMessage(), sendText);

    expect(sendText).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(runRepository.update).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: AutomationRunStatus.SENT }),
    );
  });

  it('does not retry non-transient errors (e.g. 400)', async () => {
    const { service, runRepository } = createMocks();
    const sendText = jest.fn().mockRejectedValue(new Error('HTTP 400 Bad Request'));

    await service.processIncoming('session-1', incomingMessage(), sendText);

    expect(sendText).toHaveBeenCalledTimes(1); // no retry
    expect(runRepository.update).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: AutomationRunStatus.FAILED }),
    );
  });

  // --- Pre-match skip ---
  it('skips messages from self (fromMe)', async () => {
    const { service } = createMocks();
    const sendText = jest.fn();

    await service.processIncoming('session-1', incomingMessage({ fromMe: true }), sendText);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips messages with empty body', async () => {
    const { service } = createMocks();
    const sendText = jest.fn();

    await service.processIncoming('session-1', incomingMessage({ body: '' }), sendText);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips automation echo messages', async () => {
    const { service } = createMocks();
    const sendText = jest.fn();

    await service.processIncoming(
      'session-1',
      incomingMessage({ metadata: { automation: true } }),
      sendText,
    );

    expect(sendText).not.toHaveBeenCalled();
  });

  // --- No match ---
  it('does nothing when no rule matches', async () => {
    const { service } = createMocks({ selectResult: null });
    const sendText = jest.fn();

    await service.processIncoming('session-1', incomingMessage(), sendText);

    expect(sendText).not.toHaveBeenCalled();
  });
});
