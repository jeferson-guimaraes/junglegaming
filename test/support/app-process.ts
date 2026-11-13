import { join } from 'node:path';

export interface AppLogLine {
  msg?: string;
  level?: string;
  port?: number;
  pid?: number;
  [key: string]: unknown;
}

export interface AppProcess {
  baseUrl: string;
  pid: number;
  logs: AppLogLine[];
  /** Envia o sinal e espera o processo terminar. Se não terminar no prazo, mata com SIGKILL. */
  stop(signal?: NodeJS.Signals): Promise<{ exitCode: number; logs: AppLogLine[] }>;
}

const RAIZ = join(import.meta.dir, '..', '..');
const PRAZO_INICIO_MS = 10_000;
const PRAZO_PARADA_MS = 12_000;

/** Processos ainda vivos, para que nenhum teste que falhe no meio deixe órfãos. */
const vivos = new Set<AppProcess>();

/** Derruba todo processo que os testes subiram e ainda não pararam. Use em afterEach/afterAll. */
export async function stopAllApps(): Promise<void> {
  await Promise.all([...vivos].map((app) => app.stop('SIGKILL')));
}

/**
 * Sobe a aplicação como um processo real do sistema operacional (não um módulo em memória).
 * É a base dos testes de múltiplas instâncias, queda e reinício.
 */
export async function startApp(env: Record<string, string> = {}): Promise<AppProcess> {
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: RAIZ,
    // Workers e consumer desligados por padrão: cada teste liga só o que exercita, e nenhum
    // processo de teste consome as filas padrão sem querer.
    env: {
      ...process.env,
      PORT: '0',
      LOG_LEVEL: 'info',
      CONSUMER_ENABLED: 'false',
      OUTBOX_PUBLISHER_ENABLED: 'false',
      PENDING_WORKER_ENABLED: 'false',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const logs: AppLogLine[] = [];
  let avisarPorta: (porta: number) => void = () => {};
  const portaPronta = new Promise<number>((resolve) => {
    avisarPorta = resolve;
  });

  const leitura = (async () => {
    const decoder = new TextDecoder();
    let resto = '';
    for await (const chunk of proc.stdout) {
      resto += decoder.decode(chunk, { stream: true });
      const partes = resto.split('\n');
      resto = partes.pop() ?? '';
      for (const parte of partes) {
        if (parte.trim() === '') continue;
        try {
          const linha = JSON.parse(parte) as AppLogLine;
          logs.push(linha);
          if (linha.msg === 'aplicação iniciada' && typeof linha.port === 'number') {
            avisarPorta(linha.port);
          }
        } catch {
          logs.push({ msg: parte });
        }
      }
    }
  })();

  let prazoInicio: ReturnType<typeof setTimeout> | undefined;
  let porta: number;
  try {
    porta = await Promise.race([
      portaPronta,
      proc.exited.then((codigo) => {
        throw new Error(`aplicação terminou antes de iniciar (código ${codigo})`);
      }),
      new Promise<never>((_, reject) => {
        prazoInicio = setTimeout(
          () => reject(new Error(`aplicação não iniciou em ${PRAZO_INICIO_MS} ms`)),
          PRAZO_INICIO_MS,
        );
      }),
    ]);
  } catch (erro) {
    proc.kill('SIGKILL');
    await proc.exited;
    throw erro;
  } finally {
    clearTimeout(prazoInicio);
  }

  const app: AppProcess = {
    baseUrl: `http://127.0.0.1:${porta}`,
    pid: proc.pid,
    logs,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      vivos.delete(app);
      if (proc.exitCode === null) proc.kill(signal);
      const forcar = setTimeout(() => proc.kill('SIGKILL'), PRAZO_PARADA_MS);
      try {
        const exitCode = await proc.exited;
        await leitura;
        return { exitCode, logs };
      } finally {
        clearTimeout(forcar);
      }
    },
  };
  vivos.add(app);
  return app;
}
