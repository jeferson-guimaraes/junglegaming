import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação. Hoje libera tudo: a autenticação não foi implementada
 * (decisão registrada no ARCHITECTURE.md). Com um Identity Provider, este guard validaria o
 * token e exporia a identidade do provedor para comparar com o `providerId` do payload.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
