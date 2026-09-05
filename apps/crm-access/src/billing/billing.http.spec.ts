import {
	ForbiddenException,
	type INestApplication,
	RequestMethod,
	ServiceUnavailableException,
	UnauthorizedException,
	ValidationPipe
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CrmAccessHttpExceptionFilter } from '../common/crm-access-http-exception.filter';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { CrmBillingController } from './billing.controller';
import { CrmBillingService } from './billing.service';
import { CrmBillingCapacityService } from './billing-capacity.service';
import { BillingCommerceClient } from './billing-commerce.client';
import {
	BillingOperationController,
	BillingOperationGuard
} from './billing-operation.controller';

const workspaceId = randomUUID(),
	actorSubject = 'owner-read-only',
	commandId = randomUUID();
const token = randomBytes(48).toString('base64url');
const command = {
	schemaVersion: 1,
	workspaceId,
	commandId,
	expectedBillingVersion: '2',
	expectedRenewalVersion: 1
};
const operation = {
	schemaVersion: 1,
	workspaceId,
	commandId,
	state: 'PENDING',
	requestHash: 'a'.repeat(64),
	billing: null
};
const binding = {
	schemaVersion: 1,
	workspaceId,
	actorSubject,
	commandId,
	requestHash: 'a'.repeat(64),
	fenceRevision: 1,
	targetSeats: 2
};
describe('CRM billing actual HTTP boundaries', () => {
	let app: INestApplication, origin: string;
	const capacity = {
		owner: jest.fn(),
		prepare: jest.fn(),
		execute: jest.fn(),
		authorizeOperation: jest.fn(),
		recover: jest.fn()
	};
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [CrmBillingController, BillingOperationController],
			providers: [
				CrmBillingService,
				BillingOperationGuard,
				{
					provide: ConfigService,
					useValue: {
						get: (name: string) =>
							name === 'CRM_ACCESS_BILLING_ENABLED'
								? 'true'
								: name === 'BILLING_CRM_ACCESS_COMMERCE_TOKEN'
									? token
									: undefined
					}
				},
				{ provide: CrmBillingCapacityService, useValue: capacity },
				{ provide: BillingCommerceClient, useValue: { enabled: true } },
				{ provide: CrmAccessPrismaService, useValue: {} }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.setGlobalPrefix('api/v1', {
			exclude: [
				{
					path: 'internal/v1/crm-access/billing/authorize-operation',
					method: RequestMethod.POST
				}
			]
		});
		app.useGlobalPipes(
			new ValidationPipe({
				whitelist: true,
				forbidNonWhitelisted: true,
				forbidUnknownValues: true,
				transform: true
			})
		);
		app.useGlobalFilters(new CrmAccessHttpExceptionFilter());
		await app.listen(0, '127.0.0.1');
		origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await app?.close();
	});
	beforeEach(() => {
		jest.resetAllMocks();
		capacity.owner.mockImplementation(async (_workspaceId, auth) => {
			if (auth !== 'Bearer owner-session')
				throw new UnauthorizedException();
			return actorSubject;
		});
		capacity.prepare.mockResolvedValue({ commandId });
		capacity.execute.mockResolvedValue(operation);
		capacity.authorizeOperation.mockImplementation(async body => ({
			...body,
			schemaVersion: 1,
			capacityFence: {
				operationId: commandId,
				requestHash: binding.requestHash,
				fenceRevision: 1,
				targetSeats: 2
			},
			authorized: true
		}));
		capacity.recover.mockResolvedValue({
			...operation,
			state: 'NOT_STARTED',
			requestHash: null
		});
	});
	const post = (
		path: string,
		body: unknown,
		headers: Record<string, string> = {}
	) =>
		fetch(origin + path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body)
		});
	const publicHeaders = () => ({
		authorization: 'Bearer owner-session',
		'idempotency-key': commandId
	});
	const serviceHeaders = () => ({
		'x-winwidget-service': 'billing',
		'x-winwidget-internal-token': token
	});
	it('allows owner preference commands independent of CRM business-write or Trial activation', async () => {
		const response = await post(
			'/api/v1/crm/access/billing/renewal/disable',
			command,
			publicHeaders()
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(capacity.prepare).toHaveBeenCalledWith(
			'WINCRM_DISABLE_RENEWAL',
			{ ...command, actorSubject },
			null
		);
		expect(capacity.owner).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ actorSubject: 'forged' },
		{ capacityFence: { targetSeats: 2 } },
		{ price: 0 },
		{ schemaVersion: 2 },
		{ expectedRenewalVersion: [] }
	])(
		'rejects extra or malformed public fields without echoing them %j',
		async patch => {
			const response = await post(
				'/api/v1/crm/access/billing/renewal/disable',
				{ ...command, ...patch },
				publicHeaders()
			);
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain('forged');
			expect(capacity.prepare).not.toHaveBeenCalled();
		}
	);
	it('requires user authentication and exact Idempotency-Key for public mutation', async () => {
		expect(
			(await post('/api/v1/crm/access/billing/renewal/disable', command))
				.status
		).toBe(401);
		expect(
			(
				await post('/api/v1/crm/access/billing/renewal/disable', command, {
					authorization: 'Bearer owner-session'
				})
			).status
		).toBe(400);
	});
	it('offers explicit bound order verification without any new checkout fields', async () => {
		const verify = {
			schemaVersion: 1,
			workspaceId,
			commandId,
			expectedBillingVersion: '2',
			orderId: randomUUID(),
			expectedOrderVersion: 3
		};
		const response = await post(
			'/api/v1/crm/access/billing/orders/verify',
			verify,
			publicHeaders()
		);
		expect(response.status).toBe(202);
		expect(capacity.prepare).toHaveBeenCalledWith(
			'WINCRM_VERIFY_ORDER',
			{ ...verify, actorSubject },
			null
		);
	});
	it('hides a completed response if the session actor changes during the request', async () => {
		capacity.owner
			.mockResolvedValueOnce(actorSubject)
			.mockResolvedValueOnce('new-session-actor');
		const response = await post(
			'/api/v1/crm/access/billing/renewal/disable',
			command,
			publicHeaders()
		);
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain(operation.requestHash);
	});
	it('makes unknown command recovery an explicit POST with only workspace binding', async () => {
		const response = await post(
			`/api/v1/crm/access/billing/operations/${commandId}/recover`,
			{ schemaVersion: 1, workspaceId },
			publicHeaders()
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			state: 'NOT_STARTED',
			requestHash: null
		});
		expect(capacity.recover).toHaveBeenCalledWith(
			workspaceId,
			commandId,
			actorSubject
		);
	});
	it('accepts the exact scoped reverse service pair only on its internal endpoint', async () => {
		const response = await post(
			'/internal/v1/crm-access/billing/authorize-operation',
			binding,
			serviceHeaders()
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(
			(
				await post(
					'/api/v1/internal/v1/crm-access/billing/authorize-operation',
					binding,
					serviceHeaders()
				)
			).status
		).toBe(404);
	});
	it.each([
		{},
		{
			'x-winwidget-service': 'crm-sales',
			'x-winwidget-internal-token': token
		},
		{
			'x-winwidget-service': 'billing',
			'x-winwidget-internal-token': 'wrong'
		}
	])(
		'distinguishes service credential failure from operation revocation',
		async headers => {
			const response = await post(
				'/internal/v1/crm-access/billing/authorize-operation',
				binding,
				headers as Record<string, string>
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: 'SERVICE_AUTHORIZATION_FAILED'
			});
			expect(capacity.authorizeOperation).not.toHaveBeenCalled();
		}
	);
	it('does not disguise business revocation or transient capacity reconciliation', async () => {
		capacity.authorizeOperation
			.mockRejectedValueOnce(
				new ForbiddenException({
					code: 'OPERATION_AUTHORIZATION_REVOKED',
					message: 'Revoked'
				})
			)
			.mockRejectedValueOnce(new ServiceUnavailableException('Reconcile'));
		const revoked = await post(
			'/internal/v1/crm-access/billing/authorize-operation',
			binding,
			serviceHeaders()
		);
		expect(revoked.status).toBe(403);
		expect(await revoked.json()).toMatchObject({
			code: 'OPERATION_AUTHORIZATION_REVOKED'
		});
		expect(
			(
				await post(
					'/internal/v1/crm-access/billing/authorize-operation',
					binding,
					serviceHeaders()
				)
			).status
		).toBe(503);
	});
	it.each([
		{ workspaceId: 'bad' },
		{ actorSubject: ['owner'] },
		{ fenceRevision: 0 },
		{ targetSeats: 1 },
		{ requestHash: 'B'.repeat(64) },
		{ jwt: 'never-accepted' }
	])('requires exact reverse operation binding %j', async patch => {
		expect(
			(
				await post(
					'/internal/v1/crm-access/billing/authorize-operation',
					{ ...binding, ...patch },
					serviceHeaders()
				)
			).status
		).toBe(400);
		expect(capacity.authorizeOperation).not.toHaveBeenCalled();
	});
});
