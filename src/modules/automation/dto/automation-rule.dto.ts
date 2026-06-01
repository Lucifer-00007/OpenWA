import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AutomationMode, AutomationTargetScope } from '../entities/automation-rule.entity';
import { AutomationTargetType } from '../entities/automation-target.entity';

export class AutomationTargetDto {
  @ApiProperty({ enum: AutomationTargetType })
  @IsEnum(AutomationTargetType)
  targetType: AutomationTargetType;

  @ApiProperty({ example: '919999999999@c.us' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  targetValue: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  displayName?: string;
}

export class AutomationTriggerDto {
  @ApiProperty({ example: '\\b(price|pricing|cost)\\b' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  pattern: string;

  @ApiPropertyOptional({ default: 'i' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  flags?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  replyText: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class CreateAutomationRuleDto {
  @ApiProperty()
  @IsUUID()
  sessionId: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ enum: AutomationMode })
  @IsEnum(AutomationMode)
  mode: AutomationMode;

  @ApiProperty({ enum: AutomationTargetScope })
  @IsEnum(AutomationTargetScope)
  targetScope: AutomationTargetScope;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  cooldownSeconds?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60000)
  replyDelayMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(12000)
  systemPrompt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(12000)
  userPromptTemplate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4096)
  maxTokens?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  fallbackReply?: string;

  @ApiPropertyOptional({ type: [AutomationTargetDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AutomationTargetDto)
  targets?: AutomationTargetDto[];

  @ApiPropertyOptional({ type: [AutomationTriggerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AutomationTriggerDto)
  triggers?: AutomationTriggerDto[];
}

export class UpdateAutomationRuleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: AutomationMode })
  @IsOptional()
  @IsEnum(AutomationMode)
  mode?: AutomationMode;

  @ApiPropertyOptional({ enum: AutomationTargetScope })
  @IsOptional()
  @IsEnum(AutomationTargetScope)
  targetScope?: AutomationTargetScope;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  cooldownSeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60000)
  replyDelayMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(12000)
  systemPrompt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(12000)
  userPromptTemplate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4096)
  maxTokens?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  fallbackReply?: string;

  @ApiPropertyOptional({ type: [AutomationTargetDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AutomationTargetDto)
  targets?: AutomationTargetDto[];

  @ApiPropertyOptional({ type: [AutomationTriggerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AutomationTriggerDto)
  triggers?: AutomationTriggerDto[];
}

export class ToggleAutomationRuleDto {
  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}
