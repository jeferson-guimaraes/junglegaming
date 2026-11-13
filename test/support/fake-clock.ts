import { ClockPort } from '@/application/ports';

/** Relógio controlado pelo teste: o tempo só anda quando o teste manda. */
export class FakeClock extends ClockPort {
  private atual: Date;

  constructor(inicio = new Date('2026-11-12T12:00:00.000Z')) {
    super();
    this.atual = inicio;
  }

  now(): Date {
    return new Date(this.atual);
  }

  avancar(segundos: number): void {
    this.atual = new Date(this.atual.getTime() + segundos * 1000);
  }
}
