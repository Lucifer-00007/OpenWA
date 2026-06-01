import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

@Entity('automation_providers')
export class AutomationProvider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 2048 })
  baseUrl: string;

  @Column({ type: 'text' })
  apiKeyEncrypted: string;

  @Column({ type: 'varchar', length: 150 })
  defaultModel: string;

  @Column({ type: 'text', nullable: true })
  headersEncrypted: string | null;

  @Index()
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'int', default: 15000 })
  timeoutMs: number;

  @Column({ type: 'int', default: 1 })
  maxRetries: number;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
