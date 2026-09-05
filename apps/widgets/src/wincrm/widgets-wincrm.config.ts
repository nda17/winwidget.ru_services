import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { isWidgetsInternalLoopback } from '../internal/widgets-internal.guard';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import {
	parseEligibility,
	WidgetsEligibility
} from './widgets-wincrm.contract';

@Injectable()
export class WidgetsWincrmConfig {
	readonly enabled: boolean;
	readonly apiEnabled: boolean;
	readonly intakeToken: string;
	readonly billingToken: string;
	readonly billingOrigin: string;
	readonly timeoutMs: number;
	constructor(config: ConfigService, runtime: WidgetsRuntimeService) {
		const flag =
			config.get<string>('WIDGETS_WINCRM_CONNECTOR_ENABLED') ?? 'false';
		if (flag !== 'true' && flag !== 'false')
			throw new Error(
				'WIDGETS_WINCRM_CONNECTOR_ENABLED must be true or false'
			);
		this.enabled = flag === 'true';
		this.apiEnabled = this.enabled && runtime.apiEnabled;
		this.intakeToken =
			config.get<string>('WIDGETS_CRM_INTAKE_TOKEN') || '';
		this.billingToken =
			config.get<string>('BILLING_WINCRM_WIDGETS_TOKEN') || '';
		this.billingOrigin =
			config.get<string>('BILLING_INTERNAL_BASE_URL') || '';
		this.timeoutMs = Number(
			config.get<string>('WIDGETS_WINCRM_HTTP_TIMEOUT_MS') || 3000
		);
		if (!this.apiEnabled) return;
		for (const [name, value] of [
			['WIDGETS_CRM_INTAKE_TOKEN', this.intakeToken],
			['BILLING_WINCRM_WIDGETS_TOKEN', this.billingToken]
		]) {
			if (
				!/^[!-~]{32,512}$/.test(value) ||
				/change.?me|placeholder|_token/i.test(value)
			)
				throw new Error(
					`${name} must be a non-placeholder pairwise secret`
				);
		}
		const existing = [
			'WIDGETS_INTERNAL_TOKEN',
			'WIDGETS_IDENTITY_TOKEN',
			'WIDGETS_OPERATIONS_TOKEN',
			'IDENTITY_WIDGETS_TOKEN'
		]
			.map(name => config.get<string>(name))
			.filter(Boolean);
		if (
			this.intakeToken === this.billingToken ||
			existing.includes(this.intakeToken) ||
			existing.includes(this.billingToken)
		)
			throw new Error(
				'WinCRM internal credentials must be pairwise distinct'
			);
		try {
			const url = new URL(this.billingOrigin);
			if (
				url.origin !== this.billingOrigin ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				(url.protocol !== 'https:' &&
					!(
						url.protocol === 'http:' &&
						isWidgetsInternalLoopback(
							url.hostname === '[::1]' ? '::1' : url.hostname
						)
					))
			)
				throw new Error();
		} catch {
			throw new Error(
				'BILLING_INTERNAL_BASE_URL must be an exact HTTPS origin or loopback HTTP origin'
			);
		}
		if (
			!Number.isInteger(this.timeoutMs) ||
			this.timeoutMs < 250 ||
			this.timeoutMs > 5000
		)
			throw new Error(
				'WIDGETS_WINCRM_HTTP_TIMEOUT_MS must be between 250 and 5000'
			);
	}
}

@Injectable()
export class WidgetsWincrmGuard implements CanActivate {
	constructor(private readonly config: WidgetsWincrmConfig) {}
	canActivate(context: ExecutionContext): boolean {
		if (!this.config.apiEnabled) throw new NotFoundException();
		const request = context.switchToHttp().getRequest<Request>();
		const header = (name: string) => {
			if (
				request.rawHeaders.filter(
					(_, index) =>
						index % 2 === 0 &&
						request.rawHeaders[index].toLowerCase() === name
				).length !== 1
			)
				return '';
			const value = request.headers[name];
			return typeof value === 'string' ? value : '';
		};
		const token = Buffer.from(header('x-winwidget-internal-token'));
		const expected = Buffer.from(this.config.intakeToken);
		if (
			!isWidgetsInternalLoopback(request.socket.remoteAddress) ||
			header('x-winwidget-service') !== 'crm-intake' ||
			token.length !== expected.length ||
			!timingSafeEqual(token, expected)
		)
			throw new ForbiddenException({
				code: 'widgets_wincrm_internal_forbidden'
			});
		return true;
	}
}

@Injectable()
export class WidgetsWincrmBillingClient {
	constructor(private readonly config: WidgetsWincrmConfig) {}
	async eligibility(ownerSubject: string): Promise<WidgetsEligibility> {
		if (!this.config.apiEnabled) throw new NotFoundException();
		try {
			const response = await fetch(
				`${this.config.billingOrigin}/internal/v1/billing/widgets/wincrm-eligibility`,
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(this.config.timeoutMs),
					headers: {
						'content-type': 'application/json',
						accept: 'application/json',
						'x-winwidget-service': 'widgets',
						'x-winwidget-internal-token': this.config.billingToken
					},
					body: JSON.stringify({ schemaVersion: 1, ownerSubject })
				}
			);
			if (
				response.status !== 200 ||
				response.redirected ||
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.includes('application/json') ||
				!response.body
			) {
				await response.body?.cancel();
				throw new Error();
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					length += chunk.value.byteLength;
					if (length > 8192) {
						await reader.cancel();
						throw new Error();
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			return parseEligibility(
				JSON.parse(Buffer.concat(chunks).toString('utf8')),
				ownerSubject,
				Date.now()
			);
		} catch {
			throw new ServiceUnavailableException({
				code: 'widgets_wincrm_billing_unavailable'
			});
		}
	}
}
