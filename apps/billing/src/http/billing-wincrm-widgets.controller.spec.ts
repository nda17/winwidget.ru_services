import 'reflect-metadata';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { BillingWincrmWidgetsGuard } from '../auth/billing-wincrm-widgets.guard';
import { WincrmWidgetsEligibilityService } from '../domain/wincrm-widgets-eligibility.service';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { BillingWincrmWidgetsController } from './billing-wincrm-widgets.controller';

const PATH = '/internal/v1/billing/widgets/wincrm-eligibility';
const WIDGETS = 'widgets-eligibility-http-credential-1234567890';
const INTAKE = 'intake-eligibility-http-credential-1234567890';

describe('Billing Widgets eligibility HTTP boundary', () => {
	let app: INestApplication;
	let origin: string;
	const read = jest.fn().mockResolvedValue(null);
	const start = async (enabled = true) => {
		const values: Record<string, unknown> = enabled
			? {
					BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: 'true',
					BILLING_WINCRM_WIDGETS_TOKEN: WIDGETS,
					BILLING_WINCRM_CRM_INTAKE_TOKEN: INTAKE
				}
			: {};
		const module = await Test.createTestingModule({
			controllers: [BillingWincrmWidgetsController],
			providers: [
				BillingWincrmWidgetsGuard,
				WincrmWidgetsEligibilityService,
				{
					provide: ConfigService,
					useValue: { get: (key: string) => values[key] }
				},
				{
					provide: BillingPrismaService,
					useValue: { subscription: { findUnique: read } }
				}
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.setGlobalPrefix('api/v1', {
			exclude: [{ path: PATH.slice(1), method: RequestMethod.POST }]
		});
		await app.listen(0, '127.0.0.1');
		origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
	};
	const request = (
		body: unknown = { schemaVersion: 1, ownerSubject: 'owner-1' },
		caller = 'widgets',
		token = WIDGETS,
		path = PATH
	) =>
		fetch(`${origin}${path}`, {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/json',
				'x-winwidget-service': caller,
				'x-winwidget-internal-token': token
			},
			body: JSON.stringify(body)
		});
	beforeAll(() => start());
	beforeEach(() => {
		read.mockReset().mockResolvedValue(null);
	});
	afterAll(async () => {
		await app.close();
	});

	it.each([
		['widgets', WIDGETS],
		['crm-intake', INTAKE]
	])(
		'accepts only the scoped internal caller %s and returns no-store',
		async (caller, token) => {
			const response = await request(undefined, caller, token);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body = (await response.json()) as Record<string, unknown>;
			expect(body).toEqual({
				schemaVersion: 1,
				ownerSubject: 'owner-1',
				eligible: false,
				reason: 'NO_SUBSCRIPTION',
				subscriptionId: null,
				version: null,
				plan: null,
				startsAt: null,
				expiresAt: null,
				checkedAt: expect.any(String),
				validUntil: body.checkedAt
			});
			expect(read).toHaveBeenCalledTimes(1);
		}
	);
	it.each([
		['widgets', INTAKE],
		['crm-intake', WIDGETS],
		['crm-access', WIDGETS],
		['', '']
	])(
		'rejects a missing or cross-scoped pair before reading',
		async (caller, token) => {
			expect((await request(undefined, caller, token)).status).toBe(403);
			expect(read).not.toHaveBeenCalled();
		}
	);
	it.each([
		{},
		{ schemaVersion: '1', ownerSubject: 'owner-1' },
		{ schemaVersion: 1, ownerSubject: ' owner' },
		{ schemaVersion: 1, ownerSubject: 'owner\n' },
		{ schemaVersion: 1, ownerSubject: 7 },
		{ schemaVersion: 1, ownerSubject: 'owner', commandId: 'not-allowed' },
		{ schemaVersion: 1, ownerSubject: 'x'.repeat(257) }
	])(
		'rejects a non-exact or malformed body before reading',
		async body => {
			expect((await request(body)).status).toBe(400);
			expect(read).not.toHaveBeenCalled();
		}
	);
	it('does not expose a public-prefixed alias or GET method', async () => {
		expect(
			(await request(undefined, 'widgets', WIDGETS, `/api/v1${PATH}`))
				.status
		).toBe(404);
		expect((await fetch(`${origin}${PATH}`)).status).toBe(404);
		expect(read).not.toHaveBeenCalled();
	});
	it('returns a safe unavailable error on a persisted read failure', async () => {
		read.mockRejectedValueOnce(new Error('private database diagnostic'));
		const response = await request();
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			code: 'billing_wincrm_eligibility_unavailable',
			message: 'Widgets subscription eligibility could not be confirmed'
		});
	});
	it('defaults to disabled without requiring credentials or reading the database', async () => {
		await app.close();
		await start(false);
		expect((await request()).status).toBe(404);
		expect(read).not.toHaveBeenCalled();
	});
});
