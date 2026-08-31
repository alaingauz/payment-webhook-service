import { Injectable } from '@nestjs/common';

export type LogLevel = 'info' | 'warn' | 'error';

/** Fields that cannot be overridden by caller-supplied extras. */
const PROTECTED_FIELDS = new Set(['timestamp', 'level', 'service', 'event']);

/** Fields that must never appear in log output. */
const FORBIDDEN_PATTERNS = [
  /rawBody/i,
  /payload/i,
  /x-signature/i,
  /webhook_secret/i,
  /password/i,
  /secret/i,
];

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_PATTERNS.some((p) => p.test(key));
}

function safeSerializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { error_message: String(err) };
  }
  let message = err.message;
  // Redact potential secrets from message
  message = message.replace(/WEBHOOK_SECRET[^\s]*/gi, '[REDACTED]');
  message = message.replace(/password[^\s]*/gi, '[REDACTED]');
  message = message.replace(/secret[^\s]*/gi, '[REDACTED]');
  // Redact large JSON dumps
  message = message.replace(/\{[\s\S]{200,}\}/g, '{[PAYLOAD_REDACTED]}');

  return {
    error_message: message,
    error_name: err.name,
  };
}

@Injectable()
export class StructuredLogger {
  private serviceName: string;

  constructor() {
    this.serviceName = 'api';
  }

  setService(name: string): void {
    this.serviceName = name;
  }

  info(event: string, extras?: Record<string, unknown>): void {
    this.write('info', event, extras);
  }

  warn(event: string, extras?: Record<string, unknown>): void {
    this.write('warn', event, extras);
  }

  error(event: string, extras?: Record<string, unknown>): void {
    this.write('error', event, extras);
  }

  private write(level: LogLevel, event: string, extras?: Record<string, unknown>): void {
    try {
      const entry: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        level,
        service: this.serviceName,
        event,
      };

      if (extras) {
        for (const [key, value] of Object.entries(extras)) {
          // Skip protected fields
          if (PROTECTED_FIELDS.has(key)) continue;
          // Skip forbidden fields
          if (isForbiddenKey(key)) continue;
          // Skip undefined values
          if (value === undefined) continue;

          // Serialize errors safely
          if (value instanceof Error) {
            const safe = safeSerializeError(value);
            for (const [ek, ev] of Object.entries(safe)) {
              entry[ek] = ev;
            }
            continue;
          }

          entry[key] = value;
        }
      }

      const line = JSON.stringify(entry);

      if (level === 'error') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    } catch {
      // A failure writing a log must never change business state
    }
  }
}
