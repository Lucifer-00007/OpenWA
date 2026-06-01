import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { AutomationProvider } from './automation-provider.entity';
import { AutomationTarget } from './automation-target.entity';
import { AutomationTrigger } from './automation-trigger.entity';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';

export enum AutomationMode {
  REGEX = 'regex',
  AI = 'ai',
}

export enum AutomationTargetScope {
  ALL = 'all',
  ALL_CONTACTS = 'all_contacts',
  ALL_GROUPS = 'all_groups',
  CONTACTS = 'contacts',
  GROUPS = 'groups',
}

@Entity('automation_rules')
@Index(['sessionId', 'isActive'])
@Index(['sessionId', 'priority'])
export class AutomationRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session: Session;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Index()
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'varchar', length: 20 })
  mode: AutomationMode;

  @Column({ type: 'varchar', length: 20 })
  targetScope: AutomationTargetScope;

  @Column({ type: 'int', default: 100 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  stopOnMatch: boolean;

  @Column({ type: 'int', default: 30 })
  cooldownSeconds: number;

  @Column({ type: 'int', default: 0 })
  replyDelayMs: number;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  providerId: string | null;

  @ManyToOne(() => AutomationProvider, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'providerId' })
  provider: AutomationProvider | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  model: string | null;

  @Column({ type: 'text', nullable: true })
  systemPrompt: string | null;

  @Column({ type: 'text', nullable: true })
  userPromptTemplate: string | null;

  @Column({ type: 'float', nullable: true })
  temperature: number | null;

  @Column({ type: 'int', nullable: true })
  maxTokens: number | null;

  @Column({ type: 'text', nullable: true })
  fallbackReply: string | null;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata: Record<string, unknown> | null;

  @Index()
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastTriggeredAt: Date | null;

  @OneToMany(() => AutomationTarget, target => target.rule, { cascade: true })
  targets: AutomationTarget[];

  @OneToMany(() => AutomationTrigger, trigger => trigger.rule, { cascade: true })
  triggers: AutomationTrigger[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
