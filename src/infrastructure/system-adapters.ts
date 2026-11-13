import { Injectable } from '@nestjs/common';
import { ClockPort, IdGenerator } from '@/application/ports';

@Injectable()
export class SystemClock extends ClockPort {
  now(): Date {
    return new Date();
  }
}

/** UUID v7: ordenável por tempo, o que mantém os índices das chaves primárias compactos. */
@Injectable()
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
