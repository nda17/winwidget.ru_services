import { Global, Module } from '@nestjs/common';
import { OperationsRuntimeService } from './operations-runtime.service';

@Global()
@Module({
	providers: [OperationsRuntimeService],
	exports: [OperationsRuntimeService]
})
export class OperationsRuntimeModule {}
