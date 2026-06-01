import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { AutomationRule } from './automation-rule.entity';

export enum AutomationTargetType {
  CONTACT = 'contact',
  GROUP = 'group',
}

@Entity('automation_targets')
@Index(['ruleId', 'targetType'])
@Index(['targetType', 'targetValue'])
@Unique(['ruleId', 'targetType', 'targetValue'])
export class AutomationTarget {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  ruleId: string;

  @ManyToOne(() => AutomationRule, rule => rule.targets, { onDelete: 'CASCADE' })
  rule: AutomationRule;

  @Column({ type: 'varchar', length: 20 })
  targetType: AutomationTargetType;

  @Column({ type: 'varchar', length: 150 })
  targetValue: string;

  @Column({ type: 'varchar', length: 150, nullable: true })
  displayName: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
