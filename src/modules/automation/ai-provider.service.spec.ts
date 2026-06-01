import { BadRequestException } from '@nestjs/common';
import { AutomationProvider } from './entities';
import { AiProviderService } from './ai-provider.service';
import { AutomationCryptoService } from './automation-crypto.service';

describe('AiProviderService', () => {
  let service: AiProviderService;
  let crypto: AutomationCryptoService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    crypto = new AutomationCryptoService();
    service = new AiProviderService({} as never, {} as never, crypto);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createProvider(overrides: Partial<AutomationProvider> = {}): AutomationProvider {
    return {
      id: 'provider-1',
      name: 'Test provider',
      baseUrl: 'https://example.test/v1',
      apiKeyEncrypted: crypto.encrypt(''),
      defaultModel: 'test-model',
      headersEncrypted: null,
      isActive: true,
      timeoutMs: 15000,
      maxRetries: 0,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function mockCompletionResponse(content: unknown): void {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content } }],
      }),
    }) as unknown as typeof global.fetch;
  }

  it('strips provider think blocks before returning automation reply content', async () => {
    mockCompletionResponse(`<think>
I should reason privately before answering.
</think>

My sweet baby, bas tumhare baare mein soch raha hoon 💖`);

    await expect(
      service.complete(createProvider(), {
        userPrompt: 'baby kya kar rhe ho tum ??',
      }),
    ).resolves.toBe('My sweet baby, bas tumhare baare mein soch raha hoon 💖');
  });

  it('strips orphan closing think tags and preceding reasoning', async () => {
    mockCompletionResponse(`Private chain of thought
</think>

I am here with you.`);

    await expect(
      service.complete(createProvider(), {
        userPrompt: 'What are you doing?',
      }),
    ).resolves.toBe('I am here with you.');
  });

  it('rejects responses that contain only hidden thinking', async () => {
    mockCompletionResponse('<think>No final answer yet.</think>');

    await expect(
      service.complete(createProvider(), {
        userPrompt: 'hello',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
