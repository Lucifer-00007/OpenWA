import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class TestAutomationMatchDto {
  @ApiProperty()
  @IsUUID()
  sessionId: string;

  @ApiProperty({ example: '919999999999@c.us' })
  @IsString()
  @MaxLength(150)
  chatId: string;

  @ApiProperty({ example: '919999999999@c.us' })
  @IsString()
  @MaxLength(150)
  from: string;

  @ApiProperty({ example: 'What is the price?' })
  @IsString()
  @MaxLength(4096)
  body: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

  @ApiPropertyOptional({ type: [String], example: ['120113172881475@lid', '919999999999@c.us'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(150, { each: true })
  contactIds?: string[];
}

export class TestAutomationAiDto {
  @ApiProperty({ example: 'What is the price?' })
  @IsString()
  @MaxLength(4096)
  body: string;

  @ApiPropertyOptional({ example: '919999999999@c.us' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  chatId?: string;
}
