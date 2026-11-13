import { Injectable } from '@nestjs/common';
import { type MetricLabels, Metrics } from '@/application/ports';

type Tipo = 'counter' | 'histogram' | 'gauge';

/** Catálogo das métricas. Um nome fora daqui é erro de programação. */
export const METRICAS: Record<string, { tipo: Tipo; ajuda: string }> = {
  wager_transactions_total: {
    tipo: 'counter',
    ajuda: 'Transações gravadas, por tipo, status final e canal de entrada (não conta replays).',
  },
  wager_duplicates_total: {
    tipo: 'counter',
    ajuda:
      'Duplicatas detectadas: replay idempotente, conflito de idempotência ou mensagem repetida (inbox).',
  },
  wager_retries_total: {
    tipo: 'counter',
    ajuda:
      'Novas tentativas agendadas: mensagem devolvida à fila, evento da outbox ou referência pendente.',
  },
  wager_dlq_messages_total: {
    tipo: 'counter',
    ajuda: 'Mensagens enviadas à DLQ por esta instância, por motivo.',
  },
  wager_lock_conflicts_total: {
    tipo: 'counter',
    ajuda: 'Operações interrompidas por falha transitória (lock não obtido no prazo, conexão).',
  },
  wallet_reconciliation_divergences_total: {
    tipo: 'counter',
    ajuda: 'Reconciliações em que o saldo guardado diverge do ledger.',
  },
  wager_processing_duration_seconds: {
    tipo: 'histogram',
    ajuda: 'Tempo de processamento de uma transação, por canal de entrada.',
  },
  wager_outbox_pending: { tipo: 'gauge', ajuda: 'Eventos da outbox ainda não publicados.' },
  wager_outbox_lag_seconds: {
    tipo: 'gauge',
    ajuda: 'Idade do evento pendente mais antigo da outbox (0 quando não há pendentes).',
  },
  wager_dlq_depth: { tipo: 'gauge', ajuda: 'Mensagens paradas na DLQ da fila de transações.' },
};

const LIMITES = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface Histograma {
  contagens: number[];
  soma: number;
  total: number;
}

function chave(labels: MetricLabels = {}): string {
  const pares = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  return pares
    .map(([nome, valor]) => `${nome}="${String(valor).replace(/["\\\n]/g, '_')}"`)
    .join(',');
}

const linha = (nome: string, labels: string, valor: number) =>
  `${nome}${labels ? `{${labels}}` : ''} ${valor}`;

/**
 * Registro de métricas em memória, exposto no formato de texto do Prometheus. Cada instância
 * tem o seu; quem coleta soma as séries das réplicas.
 */
@Injectable()
export class PrometheusMetrics extends Metrics {
  private readonly contadores = new Map<string, Map<string, number>>();
  private readonly histogramas = new Map<string, Map<string, Histograma>>();

  increment(name: string, labels?: MetricLabels, value = 1): void {
    this.exigir(name, 'counter');
    const series = this.contadores.get(name) ?? new Map<string, number>();
    const serie = chave(labels);
    series.set(serie, (series.get(serie) ?? 0) + value);
    this.contadores.set(name, series);
  }

  observe(name: string, seconds: number, labels?: MetricLabels): void {
    this.exigir(name, 'histogram');
    const series = this.histogramas.get(name) ?? new Map<string, Histograma>();
    const serie = chave(labels);
    const h = series.get(serie) ?? { contagens: LIMITES.map(() => 0), soma: 0, total: 0 };
    LIMITES.forEach((limite, i) => {
      if (seconds <= limite) h.contagens[i] = (h.contagens[i] ?? 0) + 1;
    });
    h.soma += seconds;
    h.total += 1;
    series.set(serie, h);
    this.histogramas.set(name, series);
  }

  /** Texto no formato de exposição do Prometheus. `gauges` são valores lidos na hora da coleta. */
  render(gauges: Record<string, number> = {}): string {
    const saida: string[] = [];
    const cabecalho = (nome: string) => {
      const definicao = METRICAS[nome];
      if (!definicao) return;
      saida.push(`# HELP ${nome} ${definicao.ajuda}`, `# TYPE ${nome} ${definicao.tipo}`);
    };
    for (const [nome, series] of this.contadores) {
      cabecalho(nome);
      for (const [labels, valor] of series) saida.push(linha(nome, labels, valor));
    }
    for (const [nome, series] of this.histogramas) {
      cabecalho(nome);
      for (const [labels, h] of series) {
        const prefixo = labels ? `${labels},` : '';
        LIMITES.forEach((limite, i) => {
          saida.push(linha(`${nome}_bucket`, `${prefixo}le="${limite}"`, h.contagens[i] ?? 0));
        });
        saida.push(linha(`${nome}_bucket`, `${prefixo}le="+Inf"`, h.total));
        saida.push(linha(`${nome}_sum`, labels, Number(h.soma.toFixed(6))));
        saida.push(linha(`${nome}_count`, labels, h.total));
      }
    }
    for (const [nome, valor] of Object.entries(gauges)) {
      this.exigir(nome, 'gauge');
      cabecalho(nome);
      saida.push(linha(nome, '', valor));
    }
    return `${saida.join('\n')}\n`;
  }

  private exigir(nome: string, tipo: Tipo): void {
    if (METRICAS[nome]?.tipo !== tipo)
      throw new Error(`Métrica ${nome} não é um ${tipo} conhecido`);
  }
}
