import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum AutomationRunStatus {
  MATCHED = 'matched',
  SKIPPED = 'skipped',
  SENT = 'sent',
  FAILED = 'failed',
  DUPLICATE = 'duplicate',
  COOLDOWN = 'cooldown',
  PROVIDER_TIMEOUT = 'provider_timeout',
  STALE = 'stale',
  RATE_LIMITED = 'rate_limited',
  QUEUE_FULL = 'queue_full',
}

@Entity('automation_runs')
@Index(['ruleId', 'sessionId', 'incomingMessageHash'], { unique: true })
@Index(['sessionId', 'chatId', 'createdAt'])
@Index(['ruleId', 'createdAt'])
@Index(['status', 'createdAt'])
@Index(['incomingMessageHash'])
export class AutomationRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  ruleId: string | null;

  @Column({ type: 'uuid' })
  sessionId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  incomingMessageId: string | null;

  @Column({ type: 'varchar', length: 64 })
  incomingMessageHash: string;

  @Column({ type: 'varchar', length: 150 })
  chatId: string;

  @Column({ type: 'varchar', length: 150 })
  senderId: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  mode: string | null;

  @Column({ type: 'varchar', length: 30 })
  status: AutomationRunStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  replyMessageId: string | null;

  @Column({ type: 'uuid', nullable: true })
  matchedTriggerId: string | null;

  @Column({ type: 'uuid', nullable: true })
  providerId: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'int', nullable: true })
  latencyMs: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
