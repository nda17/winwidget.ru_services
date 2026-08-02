import { Injectable } from '@nestjs/common';

const METRIC_NAME = /^[a-z][a-z0-9_]*$/;

@Injectable()
export class ReportingMetricsService {
	private readonly counters = new Map<string, number>();
	private readonly gauges = new Map<string, number>();

	increment(name: string, amount = 1): void {
		this.assertName(name);
		this.counters.set(name, (this.counters.get(name) || 0) + amount);
	}

	setGauge(name: string, value: number): void {
		this.assertName(name);
		if (!Number.isFinite(value))
			throw new Error('Metric value is invalid');
		this.gauges.set(name, value);
	}

	render(): string {
		const lines = [
			'# HELP winwidget_reporting_info Reporting process information.',
			'# TYPE winwidget_reporting_info gauge',
			'winwidget_reporting_info 1'
		];
		for (const [name, value] of [...this.counters].sort()) {
			lines.push(`# TYPE winwidget_reporting_${name} counter`);
			lines.push(`winwidget_reporting_${name} ${value}`);
		}
		for (const [name, value] of [...this.gauges].sort()) {
			lines.push(`# TYPE winwidget_reporting_${name} gauge`);
			lines.push(`winwidget_reporting_${name} ${value}`);
		}
		return `${lines.join('\n')}\n`;
	}

	private assertName(name: string): void {
		if (!METRIC_NAME.test(name)) throw new Error('Metric name is invalid');
	}
}
