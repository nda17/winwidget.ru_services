import { Global, Module } from '@nestjs/common';
import { PlatformRuntimeService } from './platform-runtime.service';

@Global()
@Module({
	providers: [PlatformRuntimeService],
	exports: [PlatformRuntimeService]
})
export class PlatformRuntimeModule {}
