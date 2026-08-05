import { Global, Module } from '@nestjs/common';
import { WidgetsRuntimeService } from './widgets-runtime.service';

@Global()
@Module({
	providers: [WidgetsRuntimeService],
	exports: [WidgetsRuntimeService]
})
export class WidgetsRuntimeModule {}
