import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

@Injectable()
export class AutomationCryptoService {
  private readonly key: Buffer;

  constructor() {
    const secret = process.env.AUTOMATION_SECRET_KEY || process.env.API_MASTER_KEY || 'openwa-development-automation-key';
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
  }

  decrypt(value: string): string {
    const [ivRaw, authTagRaw, encryptedRaw] = value.split('.');
    const iv = Buffer.from(ivRaw, 'base64');
    const authTag = Buffer.from(authTagRaw, 'base64');
    const encrypted = Buffer.from(encryptedRaw, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  encryptJson(value: Record<string, string>): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(value: string | null): Record<string, string> {
    if (!value) return {};
    try {
      return JSON.parse(this.decrypt(value)) as Record<string, string>;
    } catch {
      return {};
    }
  }
}
