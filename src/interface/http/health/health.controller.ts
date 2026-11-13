import { Controller, Get } from '@nestjs/common';
import { NotReadyError } from '@/application/errors';
import { Dependencies } from '../observability/dependencies';

type Estado = 'up' | 'down';

/** Health checks. Ficam fora do AuthGuard: não exigem autenticação. */
@Controller('health')
export class HealthController {
  constructor(private readonly dependencies: Dependencies) {}

  /** Liveness: o processo está de pé. Não consulta dependências. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. Responde 503 dizendo qual dependência está fora. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, Estado> }> {
    const [postgres, sqs] = await Promise.all([
      this.dependencies.postgresUp(),
      this.dependencies.sqsUp(),
    ]);
    const checks: Record<string, Estado> = {
      postgres: postgres ? 'up' : 'down',
      sqs: sqs ? 'up' : 'down',
    };
    if (!postgres || !sqs) throw new NotReadyError(checks);
    return { status: 'ok', checks };
  }
}
