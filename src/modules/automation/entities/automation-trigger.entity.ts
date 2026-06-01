import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AutomationRule } from './automation-rule.entity';

@Entity('automation_triggers')
@Index(['ruleId', 'sortOrder'])
export class AutomationTrigger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  ruleId: string;

  @ManyToOne(() => AutomationRule, rule => rule.triggers, { onDelete: 'CASCADE' })
  rule: AutomationRule;

  @Column({ type: 'varchar', length: 500 })
  pattern: string;

  @Column({ type: 'varchar', length: 10, default: 'i' })
  flags: string;

  @Column({ type: 'text' })
  replyText: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;
}
