import { AutomationRouterService } from './automation-router.service';
import { AutomationMode, AutomationRunStatus } from './router.types';

describe('AutomationRouterService', () => {
  function createService(overrides: { duplicateRun?: unknown } = {}) {
    const rule = {
      id: 'rule-1',
      sessionId: 'session-1',
      mode: AutomationMode.AI,
      cooldownSeconds: 30,
      providerId: 'provider-1',
      provider: { id: 'provider-1' },
    };
    const automationService = {
      getActiveRulesForSession: jest.fn().mockResolvedValue([rule]),
      selectMatchingRule: jest.fn().mockReturnValue({
        rule,
        match: { matched: true, reason: 'ai_scope_match' },
      }),
      renderPrompt: jest.fn().mockReturnValue('Prompt'),
    };
    const aiProviderService = {
      complete: jest.fn().mockResolvedValue('Reply'),
    };
    const runRepository = {
      findOne: jest.fn().mockResolvedValue(overrides.duplicateRun ?? null),
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

    return {
      service: new AutomationRouterService(
        automationService as never,
        aiProviderService as never,
        runRepository as never,
        messageRepository as never,
        sessionRepository as never,
      ),
      aiProviderService,
      runRepository,
      messageRepository,
    };
  }

  it('skips duplicate incoming messages without inserting another run for the same unique hash', async () => {
    const { service, aiProviderService, runRepository, messageRepository } = createService({
      duplicateRun: { id: 'existing-run', status: AutomationRunStatus.SENT },
    });
    const sendText = jest.fn().mockResolvedValue({ id: 'reply-1', timestamp: 1717240000 });

    await service.processIncoming(
      'session-1',
      {
        id: 'incoming-1',
        from: '919877073348@c.us',
        chatId: '919877073348@c.us',
        body: 'hello',
      },
      sendText,
    );

    expect(runRepository.create).not.toHaveBeenCalled();
    expect(runRepository.save).not.toHaveBeenCalled();
    expect(aiProviderService.complete).not.toHaveBeenCalled();
    expect(messageRepository.save).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('prefers a resolved phone chat id when replying to direct LID messages', async () => {
    const { service, runRepository, messageRepository } = createService();
    const sendText = jest.fn().mockResolvedValue({
      id: 'reply-1',
      timestamp: 1717240000,
      ack: 0,
    });

    await service.processIncoming(
      'session-1',
      {
        id: 'incoming-1',
        from: '3307695243467@lid',
        chatId: '3307695243467@lid',
        contactIds: ['3307695243467@lid', '919877073348@c.us'],
        body: 'hello',
      },
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
});
