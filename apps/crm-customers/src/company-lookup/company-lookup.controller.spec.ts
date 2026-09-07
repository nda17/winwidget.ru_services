import {
	ForbiddenException,
	UnauthorizedException,
	ValidationPipe
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import {
	CustomersAuthorizationClient,
	type CustomersAuthorization
} from '../access/customers-authorization.client';
import { CompanyLookupController } from './company-lookup.controller';
import { CompanyLookupService } from './company-lookup.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const inn = '7707083893';
const dto = { schemaVersion: 1 as const, workspaceId, inn };
const result = {
	schemaVersion: 1,
	provider: 'DADATA',
	queriedAt: '2026-09-07T12:00:00.000Z',
	inn,
	items: []
};
const access = (
	patch: Partial<CustomersAuthorization> = {}
): CustomersAuthorization => ({
	schemaVersion: 1,
	workspaceId,
	subject: 'actor',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [workspaceId, otherId],
	permissions: ['customers:read', 'customers:write'],
	...patch
});
const setup = () => {
	const authorize = jest.fn().mockImplementation(async () => access());
	const lookup = jest.fn().mockResolvedValue(result);
	return {
		authorize,
		lookup,
		controller: new CompanyLookupController(
			{ authorize } as unknown as CustomersAuthorizationClient,
			{ lookup } as unknown as CompanyLookupService
		)
	};
};

describe('CompanyLookupController fresh authority boundary', () => {
	it('requires both read/write permissions before provider I/O and rechecks afterward', async () => {
		const { controller, authorize, lookup } = setup();
		expect(await controller.lookup('Bearer actor', dto)).toBe(result);
		expect(authorize.mock.calls).toEqual([
			['Bearer actor', workspaceId],
			['Bearer actor', workspaceId]
		]);
		expect(lookup).toHaveBeenCalledWith(access(), inn);
	});
	it.each([
		{ state: 'READ_ONLY' as const },
		{ permissions: ['customers:read'] },
		{ permissions: ['customers:write'] },
		{ workspaceId: otherId }
	])(
		'does not call provider for unauthorized authority %#',
		async patch => {
			const { controller, authorize, lookup } = setup();
			authorize.mockResolvedValue(access(patch));
			await expect(
				controller.lookup('Bearer actor', dto)
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(lookup).not.toHaveBeenCalled();
		}
	);
	it('does not call provider on an absent or revoked user session', async () => {
		const { controller, authorize, lookup } = setup();
		authorize.mockRejectedValue(new UnauthorizedException());
		await expect(controller.lookup(undefined, dto)).rejects.toBeInstanceOf(
			UnauthorizedException
		);
		expect(lookup).not.toHaveBeenCalled();
	});
	it.each([
		{ subject: 'new-actor' },
		{ workspaceId: otherId },
		{ state: 'READ_ONLY' as const },
		{ state: 'GRACE' as const },
		{ role: 'CRM_ADMIN' as const },
		{ dataScope: 'TEAM' as const },
		{ teamIds: [otherId] },
		{ permissions: ['customers:read'] },
		{
			permissions: ['customers:read', 'customers:write', 'customers:merge']
		}
	])(
		'withholds even a cached draft if authority changes during lookup %#',
		async patch => {
			const { controller, authorize, lookup } = setup();
			authorize
				.mockResolvedValueOnce(access())
				.mockResolvedValueOnce(access(patch));
			await expect(
				controller.lookup('Bearer actor', dto)
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(lookup).toHaveBeenCalledTimes(1);
		}
	);
	it('does not mistake ordering changes for a different authority', async () => {
		const { controller, authorize } = setup();
		authorize.mockResolvedValueOnce(access()).mockResolvedValueOnce(
			access({
				teamIds: [...access().teamIds].reverse(),
				permissions: [...access().permissions].reverse()
			})
		);
		await expect(controller.lookup('Bearer actor', dto)).resolves.toBe(
			result
		);
	});
	it('withholds a result when the second fresh authorization is unavailable', async () => {
		const { controller, authorize } = setup();
		authorize
			.mockResolvedValueOnce(access())
			.mockRejectedValueOnce(new UnauthorizedException());
		await expect(
			controller.lookup('Bearer actor', dto)
		).rejects.toBeInstanceOf(UnauthorizedException);
	});
	it('rejects checksum-invalid lookup before provider or mutation', async () => {
		const { controller, lookup } = setup();
		await expect(
			controller.lookup('Bearer actor', { ...dto, inn: '7707083894' })
		).rejects.toMatchObject({
			status: 400,
			response: { code: 'crm_company_lookup_invalid_inn' }
		});
		expect(lookup).not.toHaveBeenCalled();
	});
});

describe('company lookup actual HTTP route', () => {
	let app: NestExpressApplication;
	let origin: string;
	const authorize = jest.fn();
	const lookup = jest.fn();
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [CompanyLookupController],
			providers: [
				{ provide: CustomersAuthorizationClient, useValue: { authorize } },
				{ provide: CompanyLookupService, useValue: { lookup } }
			]
		}).compile();
		app = module.createNestApplication<NestExpressApplication>({
			logger: false
		});
		app.setGlobalPrefix('api/v1');
		app.useGlobalPipes(
			new ValidationPipe({
				transform: true,
				whitelist: true,
				forbidNonWhitelisted: true,
				validationError: { target: false, value: false }
			})
		);
		await app.listen(0, '127.0.0.1');
		origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await app?.close();
	});
	beforeEach(() => {
		authorize
			.mockReset()
			.mockImplementation(async (bearer: string | undefined) => {
				if (bearer !== 'Bearer unit') throw new UnauthorizedException();
				return access();
			});
		lookup.mockReset().mockResolvedValue(result);
	});
	const request = (body: unknown, bearer: string | null = 'Bearer unit') =>
		fetch(`${origin}/api/v1/crm/customers/company-lookup`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(bearer ? { authorization: bearer } : {})
			},
			body: JSON.stringify(body)
		});
	it('returns exact projected JSON with no-store and no mutation', async () => {
		const response = await request(dto);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await response.json()).toEqual(result);
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(lookup).toHaveBeenCalledTimes(1);
	});
	it.each([
		{},
		{ ...dto, schemaVersion: 2 },
		{ ...dto, workspaceId: 'invalid' },
		{ ...dto, inn: 7707083893 },
		{ ...dto, inn: '7707083894' },
		{ ...dto, inn: `${inn}\n` },
		{ ...dto, apiKey: 'PRIVATE_CLIENT_OVERRIDE' },
		{ ...dto, providerUrl: 'PRIVATE_CLIENT_OVERRIDE' },
		{ ...dto, subject: 'PRIVATE_CLIENT_OVERRIDE' },
		{ ...dto, force: true }
	])(
		'strictly rejects malformed body or caller overrides %#',
		async body => {
			const response = await request(body);
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain(
				'PRIVATE_CLIENT_OVERRIDE'
			);
			expect(lookup).not.toHaveBeenCalled();
		}
	);
	it('requires a user session; the lookup is not a public registry proxy', async () => {
		const response = await request(dto, null);
		expect(response.status).toBe(401);
		await response.body?.cancel();
		expect(lookup).not.toHaveBeenCalled();
	});
	it('has no GET route or query-string INN lookup', async () => {
		const response = await fetch(
			`${origin}/api/v1/crm/customers/company-lookup?inn=${inn}`
		);
		expect(response.status).toBe(404);
		await response.body?.cancel();
		expect(lookup).not.toHaveBeenCalled();
	});
});
