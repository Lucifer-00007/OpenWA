import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiProviderService } from './ai-provider.service';
import {
  AutomationProviderResponseDto,
  CreateAutomationProviderDto,
  TestAutomationProviderDto,
  UpdateAutomationProviderDto,
} from './dto';

@ApiTags('automation')
@Controller('automation/providers')
export class AutomationProviderController {
  constructor(private readonly aiProviderService: AiProviderService) {}

  @Get()
  @ApiOperation({ summary: 'List AI providers' })
  findAll(): Promise<AutomationProviderResponseDto[]> {
    return this.aiProviderService.findAll();
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create an OpenAI-compatible provider' })
  create(@Body() dto: CreateAutomationProviderDto): Promise<AutomationProviderResponseDto> {
    return this.aiProviderService.create(dto);
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update an AI provider' })
  update(@Param('id') id: string, @Body() dto: UpdateAutomationProviderDto): Promise<AutomationProviderResponseDto> {
    return this.aiProviderService.update(id, dto);
  }

  @Post(':id/test')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Test an AI provider connection' })
  test(@Param('id') id: string, @Body() dto: TestAutomationProviderDto) {
    return this.aiProviderService.test(id, dto);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Delete an AI provider' })
  delete(@Param('id') id: string): Promise<void> {
    return this.aiProviderService.delete(id);
  }
}
