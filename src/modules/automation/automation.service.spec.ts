import { BadRequestException } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { AutomationMode, AutomationRule, AutomationTargetScope, AutomationTargetType } from './entities';

describe('AutomationService contact targets', () => {
  let service: AutomationService;
  let ruleRepository: Record<string, jest.Mock>;
  let targetRepository: Record<string, jest.Mock>;
  let triggerRepository: Record<string, jest.Mock>;
  let runRepository: Record<string, jest.Mock>;
  let providerRepository: Record<string, jest.Mock>;
  let aiProviderService: Record<string, jest.Mock>;

  beforeEach(() => {
    ruleRepository = {
      create: jest.fn().mockImplementation(rule => ({ id: 'rule-1', ...rule })),
      save: jest.fn().mockImplementation(rule => Promise.resolve(rule)),
      findOne: jest.fn().mockResolvedValue({ id: 'rule-1', targets: [], triggers: [] }),
      update: jest.fn(),
      remove: jest.fn(),
      findAndCount: jest.fn(),
      find: jest.fn(),
    };
    targetRepository = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn().mockImplementation(target => target),
      save: jest.fn().mockResolvedValue([]),
    };
    triggerRepository = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn().mockImplementation(trigger => trigger),
      save: jest.fn().mockResolvedValue([]),
    };
    runRepository = {
      findAndCount: jest.fn(),
    };
    providerRepository = {
      findOne: jest.fn(),
    };
    aiProviderService = {
      complete: jest.fn(),
    };

    service = new AutomationService(
      ruleRepository as never,
      targetRepository as never,
      triggerRepository as never,
      runRepository as never,
      providerRepository as never,
      aiProviderService as never,
    );
  });

  function createRule(overrides: Partial<AutomationRule>): AutomationRule {
    return {
      id: overrides.id ?? 'rule-1',
      sessionId: overrides.sessionId ?? '3b04a961-a993-466a-92fe-82713b1ae42d',
      name: overrides.name ?? 'Rule',
      description: null,
      isActive: true,
      mode: AutomationMode.REGEX,
      targetScope: AutomationTargetScope.ALL,
      priority: 100,
      stopOnMatch: true,
      cooldownSeconds: 30,
      replyDelayMs: 0,
      providerId: null,
      provider: null,
      model: null,
      systemPrompt: null,
      userPromptTemplate: null,
      temperature: null,
      maxTokens: null,
      fallbackReply: null,
      metadata: null,
      lastTriggeredAt: null,
      targets: [],
      triggers: [],
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      ...overrides,
    } as AutomationRule;
  }

  it('normalizes formatted international contact targets without assuming a country', async () => {
    await service.create({
      sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
      name: 'International contacts',
      mode: AutomationMode.REGEX,
      targetScope: AutomationTargetScope.CONTACTS,
      targets: [
        { targetType: AutomationTargetType.CONTACT, targetValue: '+1 415 555 2671' },
        { targetType: AutomationTargetType.CONTACT, targetValue: '+44 7700 900123' },
      ],
      triggers: [{ pattern: 'hello', replyText: 'Hi', flags: 'i' }],
    });

    expect(targetRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({ targetValue: '14155552671@c.us' }),
      expect.objectContaining({ targetValue: '447700900123@c.us' }),
    ]);
  });

  it('accepts existing WhatsApp contact ids', async () => {
    await service.create({
      sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
      name: 'Stored id',
      mode: AutomationMode.REGEX,
      targetScope: AutomationTargetScope.CONTACTS,
      targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '918920644582@c.us' }],
      triggers: [{ pattern: 'hello', replyText: 'Hi', flags: 'i' }],
    });

    expect(targetRepository.save).toHaveBeenCalledWith([expect.objectContaining({ targetValue: '918920644582@c.us' })]);
  });

  it('accepts WhatsApp LID contact ids when the phone number is unavailable', async () => {
    await service.create({
      sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
      name: 'Stored lid',
      mode: AutomationMode.REGEX,
      targetScope: AutomationTargetScope.CONTACTS,
      targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '120113172881475@lid' }],
      triggers: [{ pattern: 'hello', replyText: 'Hi', flags: 'i' }],
    });

    expect(targetRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({ targetValue: '120113172881475@lid' }),
    ]);
  });

  it('allows broad all-contacts and all-groups scopes without explicit targets', async () => {
    await service.create({
      sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
      name: 'All contacts',
      mode: AutomationMode.REGEX,
      targetScope: AutomationTargetScope.ALL_CONTACTS,
      triggers: [{ pattern: 'hello', replyText: 'Hi', flags: 'i' }],
    });

    await service.create({
      sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
      name: 'All groups',
      mode: AutomationMode.REGEX,
      targetScope: AutomationTargetScope.ALL_GROUPS,
      triggers: [{ pattern: 'hello', replyText: 'Hi group', flags: 'i' }],
    });

    expect(targetRepository.save).not.toHaveBeenCalled();
  });

  it('rejects explicit targets on broad all-contacts and all-groups scopes', async () => {
    await expect(
      service.create({
        sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
        name: 'Bad broad target',
        mode: AutomationMode.REGEX,
        targetScope: AutomationTargetScope.ALL_CONTACTS,
        targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '918920644582@c.us' }],
        triggers: [{ pattern: 'hello', replyText: 'Hi', flags: 'i' }],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(targetRepository.save).not.toHaveBeenCalled();
  });

  it('matches phone targets against resolved contact identifiers from LID messages', () => {
    const result = service.matchRule(
      {
        mode: AutomationMode.AI,
        targetScope: AutomationTargetScope.CONTACTS,
        targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '918918131603@c.us' }],
      } as never,
      {
        from: '120113172881475@lid',
        chatId: '120113172881475@lid',
        contactIds: ['120113172881475@lid', '918918131603@c.us'],
      },
    );

    expect(result).toEqual({ matched: true, reason: 'ai_scope_match' });
  });

  it('renders sender.phone from resolved contact identifiers', () => {
    const prompt = service.renderPrompt(
      {
        userPromptTemplate: 'Phone: {{sender.phone}}',
      } as never,
      {
        body: 'hello',
        chatId: '120113172881475@lid',
        from: '120113172881475@lid',
        contactIds: ['120113172881475@lid', '918918131603@c.us'],
        sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
      },
    );

    expect(prompt).toBe('Phone: 918918131603');
  });

  it('matches all-contacts only for direct contact chats', () => {
    const contactResult = service.matchRule(
      createRule({
        mode: AutomationMode.AI,
        targetScope: AutomationTargetScope.ALL_CONTACTS,
      }),
      {
        from: '120113172881475@lid',
        chatId: '120113172881475@lid',
        contactIds: ['120113172881475@lid', '918918131603@c.us'],
      },
    );
    const groupResult = service.matchRule(
      createRule({
        mode: AutomationMode.AI,
        targetScope: AutomationTargetScope.ALL_CONTACTS,
      }),
      {
        from: '120363000000000000@g.us',
        chatId: '120363000000000000@g.us',
        body: 'hello',
        isGroup: true,
      },
    );
    const statusResult = service.matchRule(
      createRule({
        mode: AutomationMode.AI,
        targetScope: AutomationTargetScope.ALL_CONTACTS,
      }),
      {
        from: 'status@broadcast',
        chatId: 'status@broadcast',
        body: 'hello',
      },
    );

    expect(contactResult).toEqual({ matched: true, reason: 'ai_scope_match' });
    expect(groupResult).toEqual({ matched: false, reason: 'target_not_matched' });
    expect(statusResult).toEqual({ matched: false, reason: 'target_not_matched' });
  });

  it('matches all-groups only for group chats', () => {
    const groupResult = service.matchRule(
      createRule({
        mode: AutomationMode.AI,
        targetScope: AutomationTargetScope.ALL_GROUPS,
      }),
      {
        from: '120363000000000000@g.us',
        chatId: '120363000000000000@g.us',
        body: 'hello',
        isGroup: true,
      },
    );
    const contactResult = service.matchRule(
      createRule({
        mode: AutomationMode.AI,
        targetScope: AutomationTargetScope.ALL_GROUPS,
      }),
      {
        from: '918918131603@c.us',
        chatId: '918918131603@c.us',
        body: 'hello',
      },
    );

    expect(groupResult).toEqual({ matched: true, reason: 'ai_scope_match' });
    expect(contactResult).toEqual({ matched: false, reason: 'target_not_matched' });
  });

  it('selects a matching contact rule instead of a broader all-messages rule for the same sender', () => {
    const selected = service.selectMatchingRule(
      [
        createRule({
          id: 'all-rule',
          name: 'All messages',
          targetScope: AutomationTargetScope.ALL,
          priority: 1,
          triggers: [
            { id: 'all-trigger', pattern: 'hello', flags: 'i', replyText: 'All reply', sortOrder: 0 } as never,
          ],
        }),
        createRule({
          id: 'contact-rule',
          name: 'Contact rule',
          targetScope: AutomationTargetScope.CONTACTS,
          priority: 100,
          targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '918918131603@c.us' } as never],
          triggers: [
            { id: 'contact-trigger', pattern: 'hello', flags: 'i', replyText: 'Contact reply', sortOrder: 0 } as never,
          ],
        }),
      ],
      {
        from: '120113172881475@lid',
        chatId: '120113172881475@lid',
        contactIds: ['120113172881475@lid', '918918131603@c.us'],
        body: 'hello',
      },
    );

    expect(selected?.rule.id).toBe('contact-rule');
    expect(selected?.match.replyText).toBe('Contact reply');
  });

  it('selects a specific contact rule instead of an all-contacts rule for the same sender', () => {
    const selected = service.selectMatchingRule(
      [
        createRule({
          id: 'all-contacts-rule',
          targetScope: AutomationTargetScope.ALL_CONTACTS,
          priority: 1,
          triggers: [
            {
              id: 'all-contacts-trigger',
              pattern: 'hello',
              flags: 'i',
              replyText: 'All contacts reply',
              sortOrder: 0,
            } as never,
          ],
        }),
        createRule({
          id: 'contact-rule',
          targetScope: AutomationTargetScope.CONTACTS,
          priority: 100,
          targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '918918131603@c.us' } as never],
          triggers: [
            { id: 'contact-trigger', pattern: 'hello', flags: 'i', replyText: 'Contact reply', sortOrder: 0 } as never,
          ],
        }),
      ],
      {
        from: '120113172881475@lid',
        chatId: '120113172881475@lid',
        contactIds: ['120113172881475@lid', '918918131603@c.us'],
        body: 'hello',
      },
    );

    expect(selected?.rule.id).toBe('contact-rule');
    expect(selected?.match.replyText).toBe('Contact reply');
  });

  it('selects an all-contacts rule instead of an all-messages rule for contact chats', () => {
    const selected = service.selectMatchingRule(
      [
        createRule({
          id: 'all-rule',
          targetScope: AutomationTargetScope.ALL,
          priority: 1,
          triggers: [
            { id: 'all-trigger', pattern: 'hello', flags: 'i', replyText: 'All reply', sortOrder: 0 } as never,
          ],
        }),
        createRule({
          id: 'all-contacts-rule',
          targetScope: AutomationTargetScope.ALL_CONTACTS,
          priority: 100,
          triggers: [
            {
              id: 'all-contacts-trigger',
              pattern: 'hello',
              flags: 'i',
              replyText: 'All contacts reply',
              sortOrder: 0,
            } as never,
          ],
        }),
      ],
      {
        from: '918918131603@c.us',
        chatId: '918918131603@c.us',
        body: 'hello',
      },
    );

    expect(selected?.rule.id).toBe('all-contacts-rule');
    expect(selected?.match.replyText).toBe('All contacts reply');
  });

  it('selects a specific group rule instead of an all-groups rule for the same group', () => {
    const selected = service.selectMatchingRule(
      [
        createRule({
          id: 'all-groups-rule',
          targetScope: AutomationTargetScope.ALL_GROUPS,
          priority: 1,
          triggers: [
            {
              id: 'all-groups-trigger',
              pattern: 'hello',
              flags: 'i',
              replyText: 'All groups reply',
              sortOrder: 0,
            } as never,
          ],
        }),
        createRule({
          id: 'group-rule',
          targetScope: AutomationTargetScope.GROUPS,
          priority: 100,
          targets: [{ targetType: AutomationTargetType.GROUP, targetValue: '120363000000000000@g.us' } as never],
          triggers: [
            { id: 'group-trigger', pattern: 'hello', flags: 'i', replyText: 'Group reply', sortOrder: 0 } as never,
          ],
        }),
      ],
      {
        from: '918918131603@c.us',
        chatId: '120363000000000000@g.us',
        body: 'hello group',
        isGroup: true,
      },
    );

    expect(selected?.rule.id).toBe('group-rule');
    expect(selected?.match.replyText).toBe('Group reply');
  });

  it('does not fall back to an all-messages rule when a targeted contact rule exists but does not trigger', () => {
    const selected = service.selectMatchingRule(
      [
        createRule({
          id: 'all-rule',
          targetScope: AutomationTargetScope.ALL,
          priority: 1,
          triggers: [
            { id: 'all-trigger', pattern: 'hello', flags: 'i', replyText: 'All reply', sortOrder: 0 } as never,
          ],
        }),
        createRule({
          id: 'contact-rule',
          targetScope: AutomationTargetScope.CONTACTS,
          priority: 100,
          targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '918918131603@c.us' } as never],
          triggers: [
            { id: 'contact-trigger', pattern: 'price', flags: 'i', replyText: 'Contact reply', sortOrder: 0 } as never,
          ],
        }),
      ],
      {
        from: '120113172881475@lid',
        chatId: '120113172881475@lid',
        contactIds: ['120113172881475@lid', '918918131603@c.us'],
        body: 'hello',
      },
    );

    expect(selected).toBeNull();
  });

  it('selects a matching group rule instead of a broader all-messages rule for the same group chat', () => {
    const selected = service.selectMatchingRule(
      [
        createRule({
          id: 'all-rule',
          targetScope: AutomationTargetScope.ALL,
          priority: 1,
          triggers: [
            { id: 'all-trigger', pattern: 'hello', flags: 'i', replyText: 'All reply', sortOrder: 0 } as never,
          ],
        }),
        createRule({
          id: 'group-rule',
          targetScope: AutomationTargetScope.GROUPS,
          priority: 100,
          targets: [{ targetType: AutomationTargetType.GROUP, targetValue: '120363000000000000@g.us' } as never],
          triggers: [
            { id: 'group-trigger', pattern: 'hello', flags: 'i', replyText: 'Group reply', sortOrder: 0 } as never,
          ],
        }),
      ],
      {
        from: '918918131603@c.us',
        chatId: '120363000000000000@g.us',
        body: 'hello group',
        isGroup: true,
      },
    );

    expect(selected?.rule.id).toBe('group-rule');
    expect(selected?.match.replyText).toBe('Group reply');
  });

  it('uses an all-messages rule when no targeted rule owns the sender or group', () => {
    const selected = service.selectMatchingRule(
      [
        createRule({
          id: 'all-rule',
          targetScope: AutomationTargetScope.ALL,
          triggers: [
            { id: 'all-trigger', pattern: 'hello', flags: 'i', replyText: 'All reply', sortOrder: 0 } as never,
          ],
        }),
        createRule({
          id: 'other-contact-rule',
          targetScope: AutomationTargetScope.CONTACTS,
          targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: '447700900123@c.us' } as never],
          triggers: [
            {
              id: 'contact-trigger',
              pattern: 'hello',
              flags: 'i',
              replyText: 'Other contact reply',
              sortOrder: 0,
            } as never,
          ],
        }),
      ],
      {
        from: '918918131603@c.us',
        chatId: '918918131603@c.us',
        body: 'hello',
      },
    );

    expect(selected?.rule.id).toBe('all-rule');
    expect(selected?.match.replyText).toBe('All reply');
  });

  it('rejects malformed contact targets instead of saving unusable @c.us ids', async () => {
    await expect(
      service.create({
        sessionId: '3b04a961-a993-466a-92fe-82713b1ae42d',
        name: 'Bad contact',
        mode: AutomationMode.REGEX,
        targetScope: AutomationTargetScope.CONTACTS,
        targets: [{ targetType: AutomationTargetType.CONTACT, targetValue: 'not-a-phone-number' }],
        triggers: [{ pattern: 'hello', replyText: 'Hi', flags: 'i' }],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(targetRepository.save).not.toHaveBeenCalled();
  });
});
