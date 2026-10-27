import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ProviderIdentity, ProviderIdentityPort } from '../../application/identity';
import { PROVIDER_IDENTITY } from '../../infrastructure/tokens';
import { UnauthorizedError } from './http-errors';
import { IS_PUBLIC } from './public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      identity?: ProviderIdentity;
    }>();
    const identity = await this.identities.identify({ authorization: request.headers.authorization });
    if (!identity) {
      throw new UnauthorizedError('credenciais ausentes ou inválidas');
    }
    request.identity = identity;
    return true;
  }
}
