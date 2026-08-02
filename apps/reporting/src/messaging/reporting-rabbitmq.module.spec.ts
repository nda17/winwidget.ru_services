import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingRuntimeModule } from '../runtime/reporting-runtime.module';
import { ReportingRabbitMqModule } from './reporting-rabbitmq.module';
import { ReportingRabbitMqService } from './reporting-rabbitmq.service';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

describe('ReportingRabbitMqModule', () => {
	it('resolves the shared metrics dependency without a duplicate provider', async () => {
		const module = await Test.createTestingModule({
			imports: [
				ConfigModule.forRoot({
					isGlobal: true,
					ignoreEnvFile: true,
					load: [
						() => ({
							REPORTING_PROCESS_ROLE: 'api',
							REPORTING_SCHEDULER_ENABLED: 'false'
						})
					]
				}),
				ReportingRuntimeModule,
				ReportingRabbitMqModule
			]
		}).compile();

		const rabbit = module.get(ReportingRabbitMqService);
		const metrics = module.get(ReportingMetricsService);
		expect(rabbit).toBeDefined();
		expect(metrics).toBeDefined();
		expect(
			(rabbit as unknown as { metrics: ReportingMetricsService }).metrics
		).toBe(metrics);
		await module.close();
	});
});
