import { ReportingRabbitMqService } from './reporting-rabbitmq.service';
import { ReportingMetricsModule } from '../metrics/reporting-metrics.module';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
	imports: [ReportingMetricsModule],
	providers: [ReportingRabbitMqService],
	exports: [ReportingRabbitMqService]
})
export class ReportingRabbitMqModule {}
