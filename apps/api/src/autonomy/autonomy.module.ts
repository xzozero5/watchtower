import { Module } from '@nestjs/common';

/**
 * Autonomy stage per intent and the emergency switch (T-112). Empty until the owning task adds its controllers and providers (T-123a). Add files in
 * this directory and list them here; `app.module.ts` already imports this module through
 * `features.module.ts`. Every route needs `@RequirePermission` / `@RequireAnyPermission` or
 * `@Public()`, and a public one must also be listed in `./public-routes.ts`.
 */
@Module({})
export class AutonomyModule {}
