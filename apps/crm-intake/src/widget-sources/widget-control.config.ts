import { Injectable } from '@nestjs/common';

export function widgetControlEnabled(): boolean {
	const value = process.env.CRM_INTAKE_WIDGETS_ENABLED ?? 'false';
	if (!['true', 'false'].includes(value))
		throw new Error('CRM_INTAKE_WIDGETS_ENABLED must be boolean');
	return value === 'true';
}
export function widgetOrigin(value: string | undefined): string {
	try {
		const url = new URL(value || '');
		if (
			url.origin !== value ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.protocol !== 'https:' &&
				!(
					url.protocol === 'http:' &&
					['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
				))
		)
			throw new Error();
		return url.origin;
	} catch {
		throw new Error(
			'WIDGETS_INTERNAL_BASE_URL must be exact HTTPS or loopback HTTP origin'
		);
	}
}
@Injectable()
export class WidgetControlConfig {
	readonly enabled = widgetControlEnabled();
	readonly origin: string;
	readonly token: string;
	readonly timeoutMs: number;
	constructor() {
		this.origin = this.enabled
			? widgetOrigin(process.env.WIDGETS_INTERNAL_BASE_URL)
			: '';
		this.token = this.enabled
			? process.env.WIDGETS_CRM_INTAKE_TOKEN || ''
			: '';
		this.timeoutMs = Number(
			process.env.CRM_INTAKE_WIDGETS_HTTP_TIMEOUT_MS || 3000
		);
		if (!this.enabled) return;
		if (
			!/^[!-~]{32,512}$/.test(this.token) ||
			/change.?me|placeholder|_token/i.test(this.token) ||
			[
				process.env.CRM_ACCESS_CRM_INTAKE_TOKEN,
				process.env.CRM_CUSTOMERS_CRM_INTAKE_TOKEN,
				process.env.CRM_SALES_CRM_INTAKE_TOKEN
			].includes(this.token)
		)
			throw new Error(
				'WIDGETS_CRM_INTAKE_TOKEN must be a distinct non-placeholder pairwise secret'
			);
		if (
			!Number.isInteger(this.timeoutMs) ||
			this.timeoutMs < 250 ||
			this.timeoutMs > 5000
		)
			throw new Error(
				'CRM_INTAKE_WIDGETS_HTTP_TIMEOUT_MS must be between 250 and 5000'
			);
	}
}
