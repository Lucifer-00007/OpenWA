import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AutomationService } from './automation.service';
import {
  CreateAutomationRuleDto,
  TestAutomationAiDto,
  TestAutomationMatchDto,
  ToggleAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './dto';
import { AutomationMode } from './entities';

@ApiTags('automation')
@Controller('automation')
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  @Get('rules')
  @ApiOperation({ summary: 'List automation rules' })
  findAll(
    @Query('sessionId') sessionId?: string,
    @Query('active') active?: string,
    @Query('mode') mode?: AutomationMode,
  ) {
    return this.automationService.findAll({
      sessionId,
      active: active === undefined ? undefined : active === 'true',
      mode,
    });
  }

  @Post('rules')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create an automation rule' })
  create(@Body() dto: CreateAutomationRuleDto) {
    return this.automationService.create(dto);
  }

  @Get('rules/:id')
  @ApiOperation({ summary: 'Get an automation rule' })
  findOne(@Param('id') id: string) {
    return this.automationService.findOne(id);
  }

  @Put('rules/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update an automation rule' })
  update(@Param('id') id: string, @Body() dto: UpdateAutomationRuleDto) {
    return this.automationService.update(id, dto);
  }

  @Post('rules/:id/toggle')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Enable or disable an automation rule' })
  toggle(@Param('id') id: string, @Body() dto: ToggleAutomationRuleDto) {
    return this.automationService.toggle(id, dto.isActive);
  }

  @Delete('rules/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete an automation rule' })
  delete(@Param('id') id: string) {
    return this.automationService.delete(id);
  }

  @Post('rules/test-match')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Test automation matching without sending a message' })
  testMatch(@Body() dto: TestAutomationMatchDto) {
    return this.automationService.testMatch(dto);
  }

  @Post('rules/:id/test-ai')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Test an AI automation prompt without sending a message' })
  testAi(@Param('id') id: string, @Body() dto: TestAutomationAiDto) {
    return this.automationService.testAi(id, dto);
  }

  @Get('runs')
  @ApiOperation({ summary: 'List automation runs' })
  getRuns(
    @Query('sessionId') sessionId?: string,
    @Query('ruleId') ruleId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.automationService.getRuns({
      sessionId,
      ruleId,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }
}
