import { ReportingMetricsService } from './reporting-metrics.service';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
	providers: [ReportingMetricsService],
	exports: [ReportingMetricsService]
})
export class ReportingMetricsModule {}
