import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

/**
 * EXAMPLE ONLY: "signed in" means the request carries an x-user-id header. Use your real auth
 * guard (JWT, session) instead; the package only needs request.user.id afterwards.
 */
@Injectable()
export class ExampleAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: { id: string } }>();
    const userId = request.headers["x-user-id"]?.trim();
    if (!userId) return false;
    request.user = { id: userId };
    return true;
  }
}
