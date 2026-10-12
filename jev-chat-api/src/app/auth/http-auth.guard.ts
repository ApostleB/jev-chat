import { createParamDecorator, Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "../../core";
import { ApiException } from "../rest/api-error";
import { hasRole } from "./access";
import { AUTH_PROVIDER, type AuthedPrincipal, type AuthProvider } from "./auth.types";

const ROLES = "jev:roles";
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

type Req = { headers: Record<string, string | undefined>; principal?: AuthedPrincipal };

@Injectable()
export class HttpAuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const principal = token ? await this.auth.verify(token) : null;
    if (!principal || (principal.expiresAt !== undefined && principal.expiresAt <= Date.now())) throw new ApiException("UNAUTHORIZED");
    req.principal = principal;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.every((r) => hasRole(principal, r))) throw new ApiException("FORBIDDEN");
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthedPrincipal => ctx.switchToHttp().getRequest<Req>().principal!);
