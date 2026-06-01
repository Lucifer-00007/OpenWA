import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import {
  AutomationMode,
  AutomationProvider,
  AutomationRule,
  AutomationRun,
  AutomationTarget,
  AutomationTargetScope,
  AutomationTargetType,
  AutomationTrigger,
} from './entities';
import { CreateAutomationRuleDto, TestAutomationAiDto, TestAutomationMatchDto, UpdateAutomationRuleDto } from './dto';
import { AiProviderService } from './ai-provider.service';

const CONTACT_TARGET_PATTERN = /^[1-9]\d{5,14}@c\.us$/;
const LID_TARGET_PATTERN = /^[1-9]\d{5,20}@lid$/;

type AutomationMessageForMatching = {
  from: string;
  chatId: string;
  contactIds?: string[];
  body?: string;
  isGroup?: boolean;
};

type AutomationMatchResult = {
  matched: boolean;
  reason: string;
  trigger?: AutomationTrigger;
  replyText?: string;
};

export type SelectedAutomationRule = {
  rule: AutomationRule;
  match: AutomationMatchResult;
};

@Injectable()
export class AutomationService {
  constructor(
    @InjectRepository(AutomationRule, 'data')
    private readonly ruleRepository: Repository<AutomationRule>,
    @InjectRepository(AutomationTarget, 'data')
    private readonly targetRepository: Repository<AutomationTarget>,
    @InjectRepository(AutomationTrigger, 'data')
    private readonly triggerRepository: Repository<AutomationTrigger>,
    @InjectRepository(AutomationRun, 'data')
    private readonly runRepository: Repository<AutomationRun>,
    @InjectRepository(AutomationProvider, 'data')
    private readonly providerRepository: Repository<AutomationProvider>,
    private readonly aiProviderService: AiProviderService,
  ) {}

  async create(dto: CreateAutomationRuleDto): Promise<AutomationRule> {
    await this.validateRule(dto);
    const rule = this.ruleRepository.create(this.buildRuleData(dto));
    const saved = await this.ruleRepository.save(rule);
    await this.replaceChildren(saved.id, dto);
    return this.findOne(saved.id);
  }

  async findAll(
    options: { sessionId?: string; active?: boolean; mode?: AutomationMode } = {},
  ): Promise<{ data: AutomationRule[]; total: number }> {
    const where: FindOptionsWhere<AutomationRule> = {};
    if (options.sessionId) where.sessionId = options.sessionId;
    if (options.active !== undefined) where.isActive = options.active;
    if (options.mode) where.mode = options.mode;
    const [data, total] = await this.ruleRepository.findAndCount({
      where,
      relations: ['targets', 'triggers', 'provider'],
      order: { priority: 'ASC', createdAt: 'ASC' },
    });
    return { data, total };
  }

  async findOne(id: string): Promise<AutomationRule> {
    const rule = await this.ruleRepository.findOne({
      where: { id },
      relations: ['targets', 'triggers', 'provider'],
    });
    if (!rule) throw new NotFoundException(`Automation rule ${id} not found`);
    return rule;
  }

  async update(id: string, dto: UpdateAutomationRuleDto): Promise<AutomationRule> {
    const existing = await this.findOne(id);
    const merged = { ...this.toDto(existing), ...dto } as CreateAutomationRuleDto;
    if (dto.targetScope && this.isBroadTargetScope(dto.targetScope) && dto.targets === undefined) {
      merged.targets = [];
    }
    await this.validateRule(merged);
    await this.ruleRepository.update(id, this.buildRuleData(merged));
    await this.replaceChildren(id, merged);
    return this.findOne(id);
  }

  async toggle(id: string, isActive: boolean): Promise<AutomationRule> {
    await this.findOne(id);
    await this.ruleRepository.update(id, { isActive });
    return this.findOne(id);
  }

  async delete(id: string): Promise<void> {
    const rule = await this.findOne(id);
    await this.ruleRepository.remove(rule);
  }

  async getRuns(options: { sessionId?: string; ruleId?: string; status?: string; limit?: number; offset?: number }) {
    const where: FindOptionsWhere<AutomationRun> = {};
    if (options.sessionId) where.sessionId = options.sessionId;
    if (options.ruleId) where.ruleId = options.ruleId;
    if (options.status) where.status = options.status as AutomationRun['status'];
    const [data, total] = await this.runRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(options.limit ?? 50, 200),
      skip: options.offset ?? 0,
    });
    return { data, total };
  }

  async testMatch(dto: TestAutomationMatchDto) {
    const rules = await this.getActiveRulesForSession(dto.sessionId);
    const message = {
      id: 'test-message',
      from: dto.from,
      chatId: dto.chatId,
      contactIds: dto.contactIds || [dto.from, dto.chatId],
      body: dto.body,
      isGroup: dto.isGroup ?? dto.chatId.endsWith('@g.us'),
    };
    const selected = this.selectMatchingRule(rules, message);
    if (selected) {
      const { rule, match } = selected;
      return {
        matched: true,
        ruleId: rule.id,
        ruleName: rule.name,
        mode: rule.mode,
        replyPreview: match.replyText ?? (rule.mode === AutomationMode.AI ? '[AI generated reply]' : undefined),
        reason: match.reason,
      };
    }
    return { matched: false, reason: 'no_rule_matched' };
  }

  async testAi(id: string, dto: TestAutomationAiDto) {
    const rule = await this.findOne(id);
    if (rule.mode !== AutomationMode.AI) throw new BadRequestException('Rule is not an AI automation');
    if (!rule.providerId) throw new BadRequestException('AI automation requires a provider');
    const provider = await this.providerRepository.findOne({ where: { id: rule.providerId } });
    if (!provider) throw new BadRequestException('AI provider not found');
    const startedAt = Date.now();
    const reply = await this.aiProviderService.complete(provider, {
      model: rule.model,
      systemPrompt: rule.systemPrompt,
      userPrompt: this.renderPrompt(rule, {
        body: dto.body,
        chatId: dto.chatId || 'test@c.us',
        from: dto.chatId || 'test@c.us',
        sessionId: rule.sessionId,
        isGroup: false,
      }),
      temperature: rule.temperature,
      maxTokens: rule.maxTokens,
    });
    return { success: true, latencyMs: Date.now() - startedAt, reply };
  }

  async getActiveRulesForSession(sessionId: string): Promise<AutomationRule[]> {
    return this.ruleRepository.find({
      where: { sessionId, isActive: true },
      relations: ['targets', 'triggers', 'provider'],
      order: { priority: 'ASC', createdAt: 'ASC' },
    });
  }

  matchRule(rule: AutomationRule, message: AutomationMessageForMatching): AutomationMatchResult {
    if (!this.matchesTarget(rule, message)) return { matched: false, reason: 'target_not_matched' };
    if (rule.mode === AutomationMode.AI) return { matched: true, reason: 'ai_scope_match' };

    const body = message.body || '';
    const triggers = [...(rule.triggers || [])].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const trigger of triggers) {
      try {
        const regex = new RegExp(trigger.pattern, trigger.flags || 'i');
        if (regex.test(body)) {
          return { matched: true, reason: 'regex_match', trigger, replyText: trigger.replyText };
        }
      } catch {
        continue;
      }
    }
    return { matched: false, reason: 'regex_not_matched' };
  }

  selectMatchingRule(rules: AutomationRule[], message: AutomationMessageForMatching): SelectedAutomationRule | null {
    const orderedRules = rules.map((rule, index) => ({ rule, index })).sort((a, b) => this.compareRuleOrder(a, b));
    const matchingTargetRules = orderedRules
      .map(ruleWithIndex => ({
        ...ruleWithIndex,
        targetSpecificity: this.matchesTarget(ruleWithIndex.rule, message)
          ? this.getTargetSpecificity(ruleWithIndex.rule.targetScope)
          : 0,
      }))
      .filter(({ targetSpecificity }) => targetSpecificity > 0);

    if (matchingTargetRules.length === 0) return null;

    const highestSpecificity = Math.max(...matchingTargetRules.map(({ targetSpecificity }) => targetSpecificity));
    const candidates = matchingTargetRules.filter(({ targetSpecificity }) => targetSpecificity === highestSpecificity);

    for (const { rule } of candidates) {
      const match = this.matchRule(rule, message);
      if (match.matched) return { rule, match };
    }

    return null;
  }

  renderPrompt(
    rule: AutomationRule,
    message: {
      body?: string;
      chatId: string;
      from: string;
      contactIds?: string[];
      sessionId: string;
      isGroup?: boolean;
    },
  ): string {
    const template = rule.userPromptTemplate || 'Incoming WhatsApp message: {{message.text}}\nReply concisely.';
    const replacements: Record<string, string> = {
      '{{message.text}}': message.body || '',
      '{{chat.id}}': message.chatId,
      '{{sender.id}}': message.from,
      '{{sender.phone}}': this.getSenderPhone(message),
      '{{session.id}}': message.sessionId,
      '{{isGroup}}': String(!!message.isGroup),
      '{{timestamp}}': new Date().toISOString(),
    };
    return Object.entries(replacements).reduce((text, [key, value]) => text.split(key).join(value), template);
  }

  private matchesTarget(rule: AutomationRule, message: AutomationMessageForMatching): boolean {
    if (rule.targetScope === AutomationTargetScope.ALL) return true;
    if (rule.targetScope === AutomationTargetScope.ALL_CONTACTS) return this.isContactMessage(message);
    if (rule.targetScope === AutomationTargetScope.ALL_GROUPS) return this.isGroupMessage(message);

    const targets = rule.targets || [];
    if (rule.targetScope === AutomationTargetScope.GROUPS) {
      if (!this.isGroupMessage(message)) return false;
      return targets.some(
        t =>
          t.targetType === AutomationTargetType.GROUP &&
          this.normalizeGroup(t.targetValue) === this.normalizeGroup(message.chatId),
      );
    }
    if (!this.isContactMessage(message)) return false;
    const senderIds = this.getContactCandidates(message);
    return targets.some(
      t => t.targetType === AutomationTargetType.CONTACT && senderIds.has(this.normalizeContact(t.targetValue)),
    );
  }

  private compareRuleOrder(
    a: { rule: AutomationRule; index: number },
    b: { rule: AutomationRule; index: number },
  ): number {
    const priorityA = Number.isFinite(a.rule.priority) ? a.rule.priority : 100;
    const priorityB = Number.isFinite(b.rule.priority) ? b.rule.priority : 100;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const createdA = a.rule.createdAt?.getTime?.() ?? 0;
    const createdB = b.rule.createdAt?.getTime?.() ?? 0;
    if (createdA !== createdB) return createdA - createdB;

    return a.index - b.index;
  }

  private getTargetSpecificity(scope: AutomationTargetScope): number {
    if (scope === AutomationTargetScope.CONTACTS || scope === AutomationTargetScope.GROUPS) return 3;
    if (scope === AutomationTargetScope.ALL_CONTACTS || scope === AutomationTargetScope.ALL_GROUPS) return 2;
    return 1;
  }

  private async validateRule(dto: CreateAutomationRuleDto): Promise<void> {
    if (dto.mode === AutomationMode.REGEX) {
      if (!dto.triggers?.length) throw new BadRequestException('Regex automation requires at least one trigger');
      for (const trigger of dto.triggers) {
        if (!/^[imu]*$/.test(trigger.flags || 'i'))
          throw new BadRequestException('Regex flags can only include i, m, and u');
        try {
          new RegExp(trigger.pattern, trigger.flags || 'i');
        } catch {
          throw new BadRequestException(`Invalid regex pattern: ${trigger.pattern}`);
        }
      }
    }
    if (dto.mode === AutomationMode.AI) {
      if (!dto.providerId) throw new BadRequestException('AI automation requires providerId');
      const provider = await this.providerRepository.findOne({ where: { id: dto.providerId } });
      if (!provider) throw new BadRequestException('AI provider not found');
    }
    if (this.isBroadTargetScope(dto.targetScope) && dto.targets?.length) {
      throw new BadRequestException(`${dto.targetScope} automation does not accept explicit targets`);
    }
    if (!this.isBroadTargetScope(dto.targetScope) && !dto.targets?.length) {
      throw new BadRequestException(`${dto.targetScope} automation requires at least one target`);
    }
    if (dto.targetScope === AutomationTargetScope.CONTACTS) {
      for (const target of dto.targets || []) {
        if (target.targetType !== AutomationTargetType.CONTACT) {
          throw new BadRequestException('Contact automations can only contain contact targets');
        }
        this.assertValidContactTarget(target.targetValue);
      }
    }
    if (dto.targetScope === AutomationTargetScope.GROUPS) {
      for (const target of dto.targets || []) {
        if (target.targetType !== AutomationTargetType.GROUP) {
          throw new BadRequestException('Group automations can only contain group targets');
        }
        if (!this.normalizeGroup(target.targetValue).endsWith('@g.us')) {
          throw new BadRequestException('Group targets must be WhatsApp group ids ending with @g.us');
        }
      }
    }
  }

  private buildRuleData(dto: CreateAutomationRuleDto): Record<string, unknown> {
    return {
      sessionId: dto.sessionId,
      name: dto.name,
      description: dto.description ?? null,
      isActive: dto.isActive ?? true,
      mode: dto.mode,
      targetScope: dto.targetScope,
      priority: dto.priority ?? 100,
      stopOnMatch: true,
      cooldownSeconds: dto.cooldownSeconds ?? 30,
      replyDelayMs: dto.replyDelayMs ?? 0,
      providerId: dto.mode === AutomationMode.AI ? dto.providerId! : null,
      model: dto.model ?? null,
      systemPrompt: dto.systemPrompt ?? null,
      userPromptTemplate: dto.userPromptTemplate ?? null,
      temperature: dto.temperature ?? null,
      maxTokens: dto.maxTokens ?? null,
      fallbackReply: dto.fallbackReply ?? null,
    };
  }

  private async replaceChildren(ruleId: string, dto: CreateAutomationRuleDto): Promise<void> {
    await this.targetRepository.delete({ ruleId });
    await this.triggerRepository.delete({ ruleId });
    if (dto.targets?.length) {
      await this.targetRepository.save(
        dto.targets.map(t =>
          this.targetRepository.create({
            ruleId,
            targetType: t.targetType,
            targetValue:
              t.targetType === AutomationTargetType.GROUP
                ? this.normalizeGroup(t.targetValue)
                : this.normalizeContact(t.targetValue),
            displayName: t.displayName ?? null,
          }),
        ),
      );
    }
    if (dto.mode === AutomationMode.REGEX && dto.triggers?.length) {
      await this.triggerRepository.save(
        dto.triggers.map(t =>
          this.triggerRepository.create({
            ruleId,
            pattern: t.pattern,
            flags: t.flags || 'i',
            replyText: t.replyText,
            sortOrder: t.sortOrder ?? 0,
          }),
        ),
      );
    }
  }

  private toDto(rule: AutomationRule): CreateAutomationRuleDto {
    return {
      sessionId: rule.sessionId,
      name: rule.name,
      description: rule.description ?? undefined,
      isActive: rule.isActive,
      mode: rule.mode,
      targetScope: rule.targetScope,
      priority: rule.priority,
      cooldownSeconds: rule.cooldownSeconds,
      replyDelayMs: rule.replyDelayMs,
      providerId: rule.providerId ?? undefined,
      model: rule.model ?? undefined,
      systemPrompt: rule.systemPrompt ?? undefined,
      userPromptTemplate: rule.userPromptTemplate ?? undefined,
      temperature: rule.temperature ?? undefined,
      maxTokens: rule.maxTokens ?? undefined,
      fallbackReply: rule.fallbackReply ?? undefined,
      targets: rule.targets?.map(t => ({
        targetType: t.targetType,
        targetValue: t.targetValue,
        displayName: t.displayName ?? undefined,
      })),
      triggers: rule.triggers?.map(t => ({
        pattern: t.pattern,
        flags: t.flags,
        replyText: t.replyText,
        sortOrder: t.sortOrder,
      })),
    };
  }

  private normalizeContact(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (LID_TARGET_PATTERN.test(trimmed)) return trimmed;
    const address = trimmed.replace(/@(c\.us|s\.whatsapp\.net)$/i, '');
    const digits = address.replace(/[^\d]/g, '');
    return digits ? `${digits}@c.us` : trimmed;
  }

  private assertValidContactTarget(value: string): void {
    const normalized = this.normalizeContact(value);
    if (!CONTACT_TARGET_PATTERN.test(normalized) && !LID_TARGET_PATTERN.test(normalized)) {
      throw new BadRequestException(
        `Contact target "${value}" must be an international WhatsApp contact id with country code, for example +1 415 555 2671, 14155552671@c.us, or a WhatsApp LID ending with @lid`,
      );
    }
  }

  private getContactCandidates(message: { from: string; chatId: string; contactIds?: string[] }): Set<string> {
    return new Set(
      [message.from, message.chatId, ...(message.contactIds || [])]
        .filter((value): value is string => !!value?.trim())
        .map(value => this.normalizeContact(value)),
    );
  }

  private isBroadTargetScope(scope: AutomationTargetScope): boolean {
    return (
      scope === AutomationTargetScope.ALL ||
      scope === AutomationTargetScope.ALL_CONTACTS ||
      scope === AutomationTargetScope.ALL_GROUPS
    );
  }

  private isGroupMessage(message: Pick<AutomationMessageForMatching, 'chatId' | 'isGroup'>): boolean {
    return Boolean(message.isGroup || message.chatId.endsWith('@g.us'));
  }

  private isContactMessage(
    message: Pick<AutomationMessageForMatching, 'from' | 'chatId' | 'contactIds' | 'isGroup'>,
  ): boolean {
    if (this.isGroupMessage(message)) return false;
    const senderIds = this.getContactCandidates(message);
    return [...senderIds].some(id => CONTACT_TARGET_PATTERN.test(id) || LID_TARGET_PATTERN.test(id));
  }

  private getSenderPhone(message: { from: string; contactIds?: string[] }): string {
    const phoneId = [message.from, ...(message.contactIds || [])]
      .filter((value): value is string => !!value?.trim())
      .map(value => this.normalizeContact(value))
      .find(value => CONTACT_TARGET_PATTERN.test(value));

    return phoneId ? phoneId.replace(/@c\.us$/, '') : message.from.replace(/@(c\.us|g\.us|lid)$/i, '');
  }

  private normalizeGroup(value: string): string {
    return value.trim();
  }
}
