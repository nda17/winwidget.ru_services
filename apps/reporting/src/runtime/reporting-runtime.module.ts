import { ReportingRuntimeService } from './reporting-runtime.service';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
	providers: [ReportingRuntimeService],
	exports: [ReportingRuntimeService]
})
export class ReportingRuntimeModule {}
