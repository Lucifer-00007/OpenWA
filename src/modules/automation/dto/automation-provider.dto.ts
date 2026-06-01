import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAutomationProviderDto {
  @ApiProperty({ example: 'OpenAI' })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'https://api.openai.com/v1' })
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  baseUrl: string;

  @ApiPropertyOptional({ description: 'Provider API key. Only accepted on write and never returned.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  apiKey?: string;

  @ApiProperty({ example: 'gpt-4.1-mini' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  defaultModel: string;

  @ApiPropertyOptional({ example: { 'OpenAI-Organization': 'org_123' } })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 15000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  timeoutMs?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  maxRetries?: number;
}

export class UpdateAutomationProviderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  baseUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  apiKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  defaultModel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  timeoutMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  maxRetries?: number;
}

export class TestAutomationProviderDto {
  @ApiPropertyOptional({ example: 'gpt-4.1-mini' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  model?: string;

  @ApiPropertyOptional({ example: 'Reply with the word ok' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

export interface AutomationProviderResponseDto {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  isActive: boolean;
  timeoutMs: number;
  maxRetries: number;
  hasApiKey: boolean;
  headers: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}
