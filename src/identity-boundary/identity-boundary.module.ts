import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { forwardRef, Global, Module } from '@nestjs/common';
import { CoreIdentityInternalController } from './core-identity-internal.controller';
import { CoreIdentityInternalGuard } from './core-identity-internal.guard';
import { IdentityInternalClient } from './identity-internal.client';

@Global()
@Module({
	imports: [forwardRef(() => AdminEventLogModule)],
	controllers: [CoreIdentityInternalController],
	providers: [IdentityInternalClient, CoreIdentityInternalGuard],
	exports: [IdentityInternalClient]
})
export class IdentityBoundaryModule {}
