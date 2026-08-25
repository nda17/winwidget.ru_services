import { Global, Module } from '@nestjs/common';
import { IdentityInternalClient } from './identity-internal.client';

@Global()
@Module({
	providers: [IdentityInternalClient],
	exports: [IdentityInternalClient]
})
export class IdentityBoundaryModule {}
