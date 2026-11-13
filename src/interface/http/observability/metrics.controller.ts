import { Controller, Get, Header } from '@nestjs/common';
import { Metrics } from '@/application/ports';
import type { PrometheusMetrics } from '@/infrastructure/observability/metrics';
import { Dependencies } from './dependencies';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: Metrics,
    private readonly dependencies: Dependencies,
  ) {}

  /** Formato de texto do Prometheus. Os gauges de fila e de outbox são lidos na hora da coleta. */
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async coletar(): Promise<string> {
    const [outbox, dlq] = await Promise.all([
      this.dependencies.outbox(),
      this.dependencies.dlqDepth(),
    ]);
    const gauges: Record<string, number> = {};
    if (outbox) {
      gauges.wager_outbox_pending = outbox.pending;
      gauges.wager_outbox_lag_seconds = Number(outbox.lagSeconds.toFixed(3));
    }
    if (dlq !== undefined) gauges.wager_dlq_depth = dlq;
    return (this.metrics as PrometheusMetrics).render(gauges);
  }
}
