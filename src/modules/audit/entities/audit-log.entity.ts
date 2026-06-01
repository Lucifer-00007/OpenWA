import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

export enum AuditAction {
  // API Key events
  API_KEY_CREATED = 'api_key_created',
  API_KEY_USED = 'api_key_used',
  API_KEY_REVOKED = 'api_key_revoked',
  API_KEY_DELETED = 'api_key_deleted',
  API_KEY_AUTH_FAILED = 'api_key_auth_failed',

  // Session events
  SESSION_CREATED = 'session_created',
  SESSION_STARTED = 'session_started',
  SESSION_STOPPED = 'session_stopped',
  SESSION_DELETED = 'session_deleted',
  SESSION_QR_GENERATED = 'session_qr_generated',
  SESSION_CONNECTED = 'session_connected',
  SESSION_DISCONNECTED = 'session_disconnected',

  // Message events
  MESSAGE_SENT = 'message_sent',
  MESSAGE_FAILED = 'message_failed',

  // Webhook events
  WEBHOOK_CREATED = 'webhook_created',
  WEBHOOK_DELETED = 'webhook_deleted',
  WEBHOOK_TRIGGERED = 'webhook_triggered',
  WEBHOOK_FAILED = 'webhook_failed',

  // Automation events
  AUTOMATION_PROVIDER_CREATED = 'automation_provider_created',
  AUTOMATION_PROVIDER_UPDATED = 'automation_provider_updated',
  AUTOMATION_PROVIDER_DELETED = 'automation_provider_deleted',
  AUTOMATION_PROVIDER_TESTED = 'automation_provider_tested',
  AUTOMATION_RULE_CREATED = 'automation_rule_created',
  AUTOMATION_RULE_UPDATED = 'automation_rule_updated',
  AUTOMATION_RULE_DELETED = 'automation_rule_deleted',
  AUTOMATION_RULE_ENABLED = 'automation_rule_enabled',
  AUTOMATION_RULE_DISABLED = 'automation_rule_disabled',
  AUTOMATION_REPLY_SENT = 'automation_reply_sent',
  AUTOMATION_REPLY_FAILED = 'automation_reply_failed',
}

export enum AuditSeverity {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 50 })
  action: AuditAction;

  @Column({ type: 'varchar', length: 10, default: AuditSeverity.INFO })
  severity: AuditSeverity;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  apiKeyId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  apiKeyName: string | null;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionName: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  method: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  path: string | null;

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  // The "main" database connection is always SQLite (boot config),
  // so we use simple-json regardless of the user's data DB choice.
  @Column({ type: 'simple-json', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
