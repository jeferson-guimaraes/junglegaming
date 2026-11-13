import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOMINIO = join(import.meta.dir, '..', '..', '..', 'src', 'domain');
const PERMITIDOS = [/^\.\//, /^decimal\.js$/, /^node:crypto$/];

function importsDe(arquivo: string): string[] {
  const fonte = readFileSync(join(DOMINIO, arquivo), 'utf8');
  // Cobre `from '…'`, `import '…'` (efeito colateral), `import('…')` e `require('…')`.
  const padrao = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\brequire\(\s*)['"]([^'"]+)['"]/g;
  return [...fonte.matchAll(padrao)].map((m) => m[1] ?? '');
}

describe('Pureza do domínio', () => {
  const arquivos = readdirSync(DOMINIO, { recursive: true })
    .map(String)
    .filter((nome) => nome.endsWith('.ts'));

  it('há arquivos de domínio para verificar', () => {
    expect(arquivos.length).toBeGreaterThan(5);
  });

  it.each(arquivos)('%s só importa do próprio domínio ou de bibliotecas permitidas', (arquivo) => {
    const proibidos = importsDe(arquivo).filter(
      (origem) => !PERMITIDOS.some((permitido) => permitido.test(origem)),
    );

    expect(proibidos).toEqual([]);
  });

  it.each(arquivos)('%s não usa decorators', (arquivo) => {
    const fonte = readFileSync(join(DOMINIO, arquivo), 'utf8');

    expect(fonte).not.toMatch(/^\s*@[A-Z]\w*\(/m);
  });
});
