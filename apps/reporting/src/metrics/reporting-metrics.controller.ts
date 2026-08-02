import { ReportingMetricsService } from './reporting-metrics.service';
import { Controller, Get, Header, HttpCode } from '@nestjs/common';

@Controller()
export class ReportingMetricsController {
	constructor(private readonly metrics: ReportingMetricsService) {}

	@Get('/metrics')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
	getMetrics(): string {
		return this.metrics.render();
	}
}
