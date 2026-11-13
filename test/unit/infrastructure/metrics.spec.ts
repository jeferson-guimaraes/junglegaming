import { describe, expect, it } from 'bun:test';
import { PrometheusMetrics } from '@/infrastructure/observability/metrics';

describe('PrometheusMetrics', () => {
  it('soma contadores por conjunto de labels, com HELP e TYPE', () => {
    const metrics = new PrometheusMetrics();
    metrics.increment('wager_transactions_total', {
      status: 'PROCESSED',
      kind: 'BET',
      source: 'http',
    });
    metrics.increment('wager_transactions_total', {
      source: 'http',
      kind: 'BET',
      status: 'PROCESSED',
    });
    metrics.increment('wager_transactions_total', {
      status: 'REJECTED',
      kind: 'BET',
      source: 'sqs',
    });
    metrics.increment('wager_retries_total', { component: 'outbox' }, 3);

    const texto = metrics.render();

    expect(texto).toContain('# TYPE wager_transactions_total counter');
    expect(texto).toContain('# HELP wager_transactions_total ');
    expect(texto).toContain(
      'wager_transactions_total{kind="BET",source="http",status="PROCESSED"} 2',
    );
    expect(texto).toContain(
      'wager_transactions_total{kind="BET",source="sqs",status="REJECTED"} 1',
    );
    expect(texto).toContain('wager_retries_total{component="outbox"} 3');
  });

  it('histograma: buckets cumulativos, soma e contagem', () => {
    const metrics = new PrometheusMetrics();
    metrics.observe('wager_processing_duration_seconds', 0.004, { source: 'http' });
    metrics.observe('wager_processing_duration_seconds', 0.03, { source: 'http' });
    metrics.observe('wager_processing_duration_seconds', 9, { source: 'http' });

    const texto = metrics.render();

    expect(texto).toContain('# TYPE wager_processing_duration_seconds histogram');
    expect(texto).toContain('wager_processing_duration_seconds_bucket{source="http",le="0.005"} 1');
    expect(texto).toContain('wager_processing_duration_seconds_bucket{source="http",le="0.05"} 2');
    expect(texto).toContain('wager_processing_duration_seconds_bucket{source="http",le="5"} 2');
    expect(texto).toContain('wager_processing_duration_seconds_bucket{source="http",le="+Inf"} 3');
    expect(texto).toContain('wager_processing_duration_seconds_sum{source="http"} 9.034');
    expect(texto).toContain('wager_processing_duration_seconds_count{source="http"} 3');
  });

  it('gauges são informados na coleta', () => {
    const texto = new PrometheusMetrics().render({
      wager_outbox_pending: 7,
      wager_outbox_lag_seconds: 1.5,
    });

    expect(texto).toContain('# TYPE wager_outbox_pending gauge');
    expect(texto).toContain('wager_outbox_pending 7');
    expect(texto).toContain('wager_outbox_lag_seconds 1.5');
  });

  it('um processo recém-iniciado já expõe o catálogo de contadores, com zero no que não tem label', () => {
    const texto = new PrometheusMetrics().render();

    expect(texto).toContain('# TYPE wager_transactions_total counter');
    expect(texto).toContain('# TYPE wager_dlq_messages_total counter');
    expect(texto).toContain('wallet_reconciliation_divergences_total 0');
  });

  it('nome desconhecido ou de outro tipo é erro de programação', () => {
    const metrics = new PrometheusMetrics();

    expect(() => metrics.increment('nao_existe')).toThrow();
    expect(() => metrics.observe('wager_transactions_total', 1)).toThrow();
  });

  it('neutraliza aspas e quebras de linha em valores de label', () => {
    const metrics = new PrometheusMetrics();
    metrics.increment('wager_dlq_messages_total', { reason: 'a"b\nc' });

    expect(metrics.render()).toContain('wager_dlq_messages_total{reason="a_b_c"} 1');
  });
});
