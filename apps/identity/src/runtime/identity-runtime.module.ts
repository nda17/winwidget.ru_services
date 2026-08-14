import { Global, Module } from '@nestjs/common';
import { IdentityRuntimeService } from './identity-runtime.service';

@Global()
@Module({
	providers: [IdentityRuntimeService],
	exports: [IdentityRuntimeService]
})
export class IdentityRuntimeModule {}
