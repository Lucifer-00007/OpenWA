import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutomationTables1780000000000 implements MigrationInterface {
  name = 'AddAutomationTables1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'postgres') {
      await this.upPostgres(queryRunner);
      return;
    }
    await this.upSqlite(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_triggers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_targets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_providers"`);
  }

  private async upSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_providers" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, "baseUrl" varchar(2048) NOT NULL, "apiKeyEncrypted" text NOT NULL, "defaultModel" varchar(150) NOT NULL, "headersEncrypted" text, "isActive" boolean NOT NULL DEFAULT (1), "timeoutMs" integer NOT NULL DEFAULT (15000), "maxRetries" integer NOT NULL DEFAULT (1), "metadata" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automation_providers_name" ON "automation_providers" ("name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_providers_active" ON "automation_providers" ("isActive")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_rules" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "description" varchar(500), "isActive" boolean NOT NULL DEFAULT (1), "mode" varchar(20) NOT NULL, "targetScope" varchar(20) NOT NULL, "priority" integer NOT NULL DEFAULT (100), "stopOnMatch" boolean NOT NULL DEFAULT (1), "cooldownSeconds" integer NOT NULL DEFAULT (30), "replyDelayMs" integer NOT NULL DEFAULT (0), "providerId" varchar, "model" varchar(150), "systemPrompt" text, "userPromptTemplate" text, "temperature" float, "maxTokens" integer, "fallbackReply" text, "metadata" text, "lastTriggeredAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_automation_rules_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE, CONSTRAINT "FK_automation_rules_provider" FOREIGN KEY ("providerId") REFERENCES "automation_providers" ("id") ON DELETE SET NULL)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_rules_session_active" ON "automation_rules" ("sessionId", "isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_rules_session_priority" ON "automation_rules" ("sessionId", "priority")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_rules_provider" ON "automation_rules" ("providerId")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_targets" ("id" varchar PRIMARY KEY NOT NULL, "ruleId" varchar NOT NULL, "targetType" varchar(20) NOT NULL, "targetValue" varchar(150) NOT NULL, "displayName" varchar(150), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_automation_targets_rule" FOREIGN KEY ("ruleId") REFERENCES "automation_rules" ("id") ON DELETE CASCADE, CONSTRAINT "UQ_automation_targets" UNIQUE ("ruleId", "targetType", "targetValue"))`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_targets_rule_type" ON "automation_targets" ("ruleId", "targetType")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_targets_value" ON "automation_targets" ("targetType", "targetValue")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_triggers" ("id" varchar PRIMARY KEY NOT NULL, "ruleId" varchar NOT NULL, "pattern" varchar(500) NOT NULL, "flags" varchar(10) NOT NULL DEFAULT ('i'), "replyText" text NOT NULL, "sortOrder" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_automation_triggers_rule" FOREIGN KEY ("ruleId") REFERENCES "automation_rules" ("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_triggers_order" ON "automation_triggers" ("ruleId", "sortOrder")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_runs" ("id" varchar PRIMARY KEY NOT NULL, "ruleId" varchar, "sessionId" varchar NOT NULL, "incomingMessageId" varchar(255), "incomingMessageHash" varchar(64) NOT NULL, "chatId" varchar(150) NOT NULL, "senderId" varchar(150) NOT NULL, "mode" varchar(20), "status" varchar(30) NOT NULL, "replyMessageId" varchar(255), "matchedTriggerId" varchar, "providerId" varchar, "errorCode" varchar(80), "errorMessage" text, "latencyMs" integer, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automation_runs_unique" ON "automation_runs" ("ruleId", "sessionId", "incomingMessageHash")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_runs_session_chat" ON "automation_runs" ("sessionId", "chatId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_runs_rule_created" ON "automation_runs" ("ruleId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_runs_status_created" ON "automation_runs" ("status", "createdAt")`);
  }

  private async upPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_providers" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "name" varchar(100) NOT NULL, "baseUrl" varchar(2048) NOT NULL, "apiKeyEncrypted" text NOT NULL, "defaultModel" varchar(150) NOT NULL, "headersEncrypted" text, "isActive" boolean NOT NULL DEFAULT true, "timeoutMs" integer NOT NULL DEFAULT 15000, "maxRetries" integer NOT NULL DEFAULT 1, "metadata" jsonb, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW())`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automation_providers_name" ON "automation_providers" ("name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_providers_active" ON "automation_providers" ("isActive")`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_rules" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "description" varchar(500), "isActive" boolean NOT NULL DEFAULT true, "mode" varchar(20) NOT NULL, "targetScope" varchar(20) NOT NULL, "priority" integer NOT NULL DEFAULT 100, "stopOnMatch" boolean NOT NULL DEFAULT true, "cooldownSeconds" integer NOT NULL DEFAULT 30, "replyDelayMs" integer NOT NULL DEFAULT 0, "providerId" varchar, "model" varchar(150), "systemPrompt" text, "userPromptTemplate" text, "temperature" double precision, "maxTokens" integer, "fallbackReply" text, "metadata" jsonb, "lastTriggeredAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_automation_rules_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE, CONSTRAINT "FK_automation_rules_provider" FOREIGN KEY ("providerId") REFERENCES "automation_providers" ("id") ON DELETE SET NULL)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_rules_session_active" ON "automation_rules" ("sessionId", "isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_rules_session_priority" ON "automation_rules" ("sessionId", "priority")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_rules_provider" ON "automation_rules" ("providerId")`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_targets" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "ruleId" varchar NOT NULL, "targetType" varchar(20) NOT NULL, "targetValue" varchar(150) NOT NULL, "displayName" varchar(150), "createdAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_automation_targets_rule" FOREIGN KEY ("ruleId") REFERENCES "automation_rules" ("id") ON DELETE CASCADE, CONSTRAINT "UQ_automation_targets" UNIQUE ("ruleId", "targetType", "targetValue"))`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_targets_rule_type" ON "automation_targets" ("ruleId", "targetType")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_targets_value" ON "automation_targets" ("targetType", "targetValue")`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_triggers" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "ruleId" varchar NOT NULL, "pattern" varchar(500) NOT NULL, "flags" varchar(10) NOT NULL DEFAULT 'i', "replyText" text NOT NULL, "sortOrder" integer NOT NULL DEFAULT 0, "createdAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_automation_triggers_rule" FOREIGN KEY ("ruleId") REFERENCES "automation_rules" ("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_triggers_order" ON "automation_triggers" ("ruleId", "sortOrder")`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "automation_runs" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "ruleId" varchar, "sessionId" varchar NOT NULL, "incomingMessageId" varchar(255), "incomingMessageHash" varchar(64) NOT NULL, "chatId" varchar(150) NOT NULL, "senderId" varchar(150) NOT NULL, "mode" varchar(20), "status" varchar(30) NOT NULL, "replyMessageId" varchar(255), "matchedTriggerId" varchar, "providerId" varchar, "errorCode" varchar(80), "errorMessage" text, "latencyMs" integer, "createdAt" timestamp NOT NULL DEFAULT NOW())`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_automation_runs_unique" ON "automation_runs" ("ruleId", "sessionId", "incomingMessageHash")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_runs_session_chat" ON "automation_runs" ("sessionId", "chatId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_runs_rule_created" ON "automation_runs" ("ruleId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_automation_runs_status_created" ON "automation_runs" ("status", "createdAt")`);
  }
}
