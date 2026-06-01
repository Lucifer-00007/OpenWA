import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AutomationProvider, AutomationRule } from './entities';
import {
  AutomationProviderResponseDto,
  CreateAutomationProviderDto,
  TestAutomationProviderDto,
  UpdateAutomationProviderDto,
} from './dto';
import { AutomationCryptoService } from './automation-crypto.service';
import { createLogger } from '../../common/services/logger.service';

interface ChatCompletionOptions {
  systemPrompt?: string | null;
  userPrompt: string;
  model?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
}

type ChatMessageContent = string | Array<string | { text?: string; content?: string }> | null | undefined;

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    text?: string | null;
    delta?: {
      content?: string | null;
    };
    message?: {
      content?: ChatMessageContent;
      refusal?: string | null;
      reasoning?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

class EmptyAssistantContentError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

@Injectable()
export class AiProviderService {
  private readonly logger = createLogger('AiProviderService');

  constructor(
    @InjectRepository(AutomationProvider, 'data')
    private readonly providerRepository: Repository<AutomationProvider>,
    @InjectRepository(AutomationRule, 'data')
    private readonly ruleRepository: Repository<AutomationRule>,
    private readonly crypto: AutomationCryptoService,
  ) {}

  async create(dto: CreateAutomationProviderDto): Promise<AutomationProviderResponseDto> {
    this.validateHeaders(dto.headers);
    const provider = this.providerRepository.create({
      name: dto.name,
      baseUrl: this.normalizeBaseUrl(dto.baseUrl),
      apiKeyEncrypted: this.crypto.encrypt(dto.apiKey ?? ''),
      defaultModel: dto.defaultModel,
      headersEncrypted: dto.headers ? this.crypto.encryptJson(dto.headers) : null,
      isActive: dto.isActive ?? true,
      timeoutMs: dto.timeoutMs ?? 15000,
      maxRetries: dto.maxRetries ?? 1,
    });
    return this.toResponse(await this.providerRepository.save(provider));
  }

  async findAll(): Promise<AutomationProviderResponseDto[]> {
    const providers = await this.providerRepository.find({ order: { createdAt: 'DESC' } });
    return providers.map(p => this.toResponse(p));
  }

  async findOne(id: string): Promise<AutomationProvider> {
    const provider = await this.providerRepository.findOne({ where: { id } });
    if (!provider) throw new NotFoundException(`AI provider ${id} not found`);
    return provider;
  }

  async update(id: string, dto: UpdateAutomationProviderDto): Promise<AutomationProviderResponseDto> {
    this.validateHeaders(dto.headers);
    const provider = await this.findOne(id);
    if (dto.name !== undefined) provider.name = dto.name;
    if (dto.baseUrl !== undefined) provider.baseUrl = this.normalizeBaseUrl(dto.baseUrl);
    if (dto.apiKey !== undefined) provider.apiKeyEncrypted = this.crypto.encrypt(dto.apiKey);
    if (dto.defaultModel !== undefined) provider.defaultModel = dto.defaultModel;
    if (dto.headers !== undefined) provider.headersEncrypted = this.crypto.encryptJson(dto.headers);
    if (dto.isActive !== undefined) provider.isActive = dto.isActive;
    if (dto.timeoutMs !== undefined) provider.timeoutMs = dto.timeoutMs;
    if (dto.maxRetries !== undefined) provider.maxRetries = dto.maxRetries;
    return this.toResponse(await this.providerRepository.save(provider));
  }

  async delete(id: string): Promise<void> {
    const provider = await this.findOne(id);
    await this.ruleRepository.update({ providerId: id }, { providerId: null });
    await this.providerRepository.delete(provider.id);
  }

  async test(id: string, dto: TestAutomationProviderDto): Promise<{ success: boolean; latencyMs: number; model: string; sample: string }> {
    const provider = await this.findOne(id);
    const startedAt = Date.now();
    const sample = await this.complete(provider, {
      model: dto.model,
      systemPrompt: 'You are testing an OpenAI-compatible provider connection.',
      userPrompt: dto.message || 'Reply with the word ok.',
      maxTokens: 512,
      temperature: 0,
    });
    return {
      success: true,
      latencyMs: Date.now() - startedAt,
      model: dto.model || provider.defaultModel,
      sample,
    };
  }

  async complete(provider: AutomationProvider, options: ChatCompletionOptions): Promise<string> {
    if (!provider.isActive) throw new BadRequestException('AI provider is inactive');

    const apiKey = this.crypto.decrypt(provider.apiKeyEncrypted).trim();
    const customHeaders = this.crypto.decryptJson(provider.headersEncrypted);
    const model = options.model || provider.defaultModel;
    const body = {
      model,
      messages: [
        ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
        { role: 'user', content: options.userPrompt },
      ],
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens ?? 512,
    };
    const maxRecoveryTokens = Math.max(body.max_tokens, 2048);

    let attempt = 0;
    let lastError: unknown;
    const maxAttempts = Math.max(provider.maxRetries + 1, 1);

    while (attempt < maxAttempts) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
        const response = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...customHeaders,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text().catch(() => response.statusText);
          if (![408, 429].includes(response.status) && response.status < 500) {
            throw new BadRequestException(`AI provider returned HTTP ${response.status}: ${text.slice(0, 300)}`);
          }
          throw new Error(`AI provider returned HTTP ${response.status}: ${text.slice(0, 300)}`);
        }

        const data = (await response.json()) as ChatCompletionResponse;
        if (data.error?.message) throw new BadRequestException(`AI provider returned an error: ${data.error.message}`);
        const content = this.extractAssistantContent(data);
        return content.slice(0, 4096);
      } catch (error) {
        if (error instanceof EmptyAssistantContentError && error.retryable && body.max_tokens < maxRecoveryTokens) {
          body.max_tokens = Math.min(Math.max(body.max_tokens * 4, 512), maxRecoveryTokens);
          lastError = error;
          continue;
        }

        lastError = error instanceof EmptyAssistantContentError ? new BadRequestException(error.message) : error;
        attempt++;
        if (attempt >= maxAttempts || lastError instanceof BadRequestException) break;
        const delay = attempt === 1 ? 500 : 1500;
        await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 250)));
      }
    }

    this.logger.warn('AI provider completion failed', {
      providerId: provider.id,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  toResponse(provider: AutomationProvider): AutomationProviderResponseDto {
    const headers = this.crypto.decryptJson(provider.headersEncrypted);
    const maskedHeaders = Object.fromEntries(Object.keys(headers).map(k => [k, '****']));
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      isActive: provider.isActive,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
      hasApiKey: this.hasApiKey(provider),
      headers: maskedHeaders,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    };
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  }

  private validateHeaders(headers?: Record<string, string>): void {
    if (!headers) return;
    const entries = Object.entries(headers);
    if (entries.length > 20) throw new BadRequestException('Provider headers cannot exceed 20 entries');
    for (const [key, value] of entries) {
      if (key.length > 100 || String(value).length > 1000) {
        throw new BadRequestException('Provider header keys or values are too long');
      }
    }
  }

  private extractAssistantContent(data: ChatCompletionResponse): string {
    const choice = data.choices?.[0];
    const rawContent = choice?.message?.content;
    const content = [this.normalizeContent(rawContent), choice?.text, choice?.delta?.content]
      .map(value => (value ? this.sanitizeAssistantContent(value) : null))
      .find((value): value is string => !!value);

    if (content) return content;

    const finishReason = choice?.finish_reason || choice?.native_finish_reason;
    if (finishReason === 'length') {
      throw new EmptyAssistantContentError(
        'AI provider exhausted max_tokens before returning assistant content. Increase max tokens or choose a non-reasoning model.',
        true,
      );
    }
    if (choice?.message?.refusal) throw new BadRequestException(`AI provider refused the request: ${choice.message.refusal}`);
    if (choice?.message?.reasoning) {
      throw new EmptyAssistantContentError('AI provider returned reasoning but no assistant content. Increase max tokens or choose another model.', true);
    }
    throw new EmptyAssistantContentError('AI provider returned no assistant content', false);
  }

  private normalizeContent(content: ChatMessageContent): string | null {
    if (typeof content === 'string') return content.trim() || null;
    if (!Array.isArray(content)) return null;

    const text = content
      .map(part => {
        if (typeof part === 'string') return part;
        return part.text || part.content || '';
      })
      .join('')
      .trim();
    return text || null;
  }

  private sanitizeAssistantContent(content: string): string | null {
    let text = content.replace(/\r\n/g, '\n');

    text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');

    const closingThinkIndex = text.toLowerCase().lastIndexOf('</think>');
    if (closingThinkIndex >= 0) {
      text = text.slice(closingThinkIndex + '</think>'.length);
    }

    text = text.replace(/<think\b[^>]*>[\s\S]*$/i, '').trim();
    return text || null;
  }

  private hasApiKey(provider: AutomationProvider): boolean {
    try {
      return this.crypto.decrypt(provider.apiKeyEncrypted).trim().length > 0;
    } catch {
      return false;
    }
  }
}
