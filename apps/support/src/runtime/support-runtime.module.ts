import { Global, Module } from '@nestjs/common';
import { SupportRuntimeService } from './support-runtime.service';

@Global()
@Module({
	providers: [SupportRuntimeService],
	exports: [SupportRuntimeService]
})
export class SupportRuntimeModule {}
