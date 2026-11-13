import { InvalidPayloadError } from '@/application/errors';
import { InvalidMoneyError } from '@/domain/errors';
import { Money } from '@/domain/money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function objeto(valor: unknown, campo: string): Record<string, unknown> {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new InvalidPayloadError(`${campo} deve ser um objeto`);
  }
  return valor as Record<string, unknown>;
}

export function uuid(valor: unknown, campo: string): string {
  if (typeof valor !== 'string' || !UUID.test(valor)) {
    throw new InvalidPayloadError(`${campo} deve ser um UUID`);
  }
  return valor.toLowerCase();
}

export function money(valor: unknown, campo: string): Money {
  const props = objeto(valor, campo);
  try {
    return Money.from({ amount: props.amount as string, currency: props.currency as string });
  } catch (erro) {
    if (erro instanceof InvalidMoneyError) {
      throw new InvalidPayloadError(`${campo}: ${erro.message}`);
    }
    throw erro;
  }
}
