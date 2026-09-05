import {
	BadRequestException,
	ServiceUnavailableException
} from '@nestjs/common';
import { WincrmWidgetsEligibilityService } from './wincrm-widgets-eligibility.service';

const NOW = new Date('2026-09-05T12:00:00.123Z');
const subscription = () => ({
	id: 'cmf01subscription0000000001',
	userId: 'owner-1',
	plan: 'EASY',
	status: 'ACTIVE',
	startsAt: new Date('2026-09-01T12:00:00.000Z'),
	expiresAt: new Date('2026-10-01T12:00:00.000Z'),
	aggregateVersion: 17n
});

describe('WincrmWidgetsEligibilityService', () => {
	let read: jest.Mock;
	let service: WincrmWidgetsEligibilityService;
	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(NOW);
		read = jest.fn().mockResolvedValue(subscription());
		const prisma = new Proxy(
			{ subscription: { findUnique: read } },
			{
				get(target, key) {
					if (key !== 'subscription')
						throw new Error('Unexpected database capability');
					return target.subscription;
				}
			}
		);
		service = new WincrmWidgetsEligibilityService(prisma as never);
	});
	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('reads only the persisted owner-scoped subscription and returns an exact CUID snapshot', async () => {
		const fetch = jest.spyOn(globalThis, 'fetch');
		expect(await service.read('owner-1')).toEqual({
			schemaVersion: 1,
			ownerSubject: 'owner-1',
			eligible: true,
			reason: 'ELIGIBLE',
			subscriptionId: 'cmf01subscription0000000001',
			version: '17',
			plan: 'EASY',
			startsAt: '2026-09-01T12:00:00.000Z',
			expiresAt: '2026-10-01T12:00:00.000Z',
			checkedAt: NOW.toISOString(),
			validUntil: '2026-09-05T12:00:05.123Z'
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith({
			where: { userId: 'owner-1' },
			select: {
				id: true,
				userId: true,
				plan: true,
				status: true,
				startsAt: true,
				expiresAt: true,
				aggregateVersion: true
			}
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(['EASY', 'HARD'])(
		'allows active %s independent of payment provenance',
		async plan => {
			read.mockResolvedValue({
				...subscription(),
				plan,
				aggregateVersion: 0n
			});
			expect(await service.read('owner-1')).toMatchObject({
				eligible: true,
				plan,
				version: '0'
			});
		}
	);
	it('does not create a trial when the subscription is absent', async () => {
		read.mockResolvedValue(null);
		expect(await service.read('owner-1')).toEqual({
			schemaVersion: 1,
			ownerSubject: 'owner-1',
			eligible: false,
			reason: 'NO_SUBSCRIPTION',
			subscriptionId: null,
			version: null,
			plan: null,
			startsAt: null,
			expiresAt: null,
			checkedAt: NOW.toISOString(),
			validUntil: NOW.toISOString()
		});
	});
	it.each([
		[{ plan: 'TRIAL' }, 'TRIAL'],
		[{ plan: 'TRIAL', expiresAt: null }, 'TRIAL'],
		[{ status: 'CANCELLED', expiresAt: null }, 'INACTIVE'],
		[{ status: 'EXPIRED', expiresAt: null }, 'INACTIVE'],
		[{ startsAt: new Date(NOW.getTime() + 1) }, 'NOT_STARTED'],
		[{ expiresAt: NOW }, 'EXPIRED'],
		[{ expiresAt: new Date(NOW.getTime() - 1) }, 'EXPIRED']
	])(
		'denies a known ineligible persisted state %j',
		async (patch, reason) => {
			read.mockResolvedValue({ ...subscription(), ...patch });
			expect(await service.read('owner-1')).toMatchObject({
				eligible: false,
				reason,
				validUntil: NOW.toISOString()
			});
		}
	);
	it('includes startsAt equality and never extends the exact expiration millisecond', async () => {
		const expiresAt = new Date(NOW.getTime() + 1);
		read.mockResolvedValue({
			...subscription(),
			startsAt: NOW,
			expiresAt
		});
		expect(await service.read('owner-1')).toMatchObject({
			eligible: true,
			validUntil: expiresAt.toISOString()
		});
	});
	it('evaluates expiry after database latency and re-reads on every request', async () => {
		read.mockImplementationOnce(async () => {
			jest.setSystemTime(new Date(NOW.getTime() + 10_000));
			return {
				...subscription(),
				expiresAt: new Date(NOW.getTime() + 5000)
			};
		});
		expect(await service.read('owner-1')).toMatchObject({
			eligible: false,
			reason: 'EXPIRED'
		});
		read.mockResolvedValue({ ...subscription(), status: 'CANCELLED' });
		expect(await service.read('owner-1')).toMatchObject({
			eligible: false,
			reason: 'INACTIVE'
		});
		expect(read).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ plan: 'UNKNOWN' },
		{ status: 'UNKNOWN' },
		{ id: '' },
		{ id: 'bad id' },
		{ userId: 'foreign-owner' },
		{ startsAt: new Date('invalid') },
		{ startsAt: null },
		{ expiresAt: new Date('invalid') },
		{ expiresAt: null },
		{ expiresAt: new Date('2026-09-01T12:00:00.000Z') },
		{ aggregateVersion: -1n },
		{ aggregateVersion: 1 },
		{ aggregateVersion: 9_223_372_036_854_775_808n }
	])('fails closed for an inconsistent snapshot', async patch => {
		read.mockResolvedValue({ ...subscription(), ...patch });
		await expect(service.read('owner-1')).rejects.toThrow(
			ServiceUnavailableException
		);
	});
	it('sanitizes database failures without exposing connection details', async () => {
		read.mockRejectedValue(new Error('private connection diagnostic'));
		await expect(service.read('owner-1')).rejects.toMatchObject({
			response: {
				code: 'billing_wincrm_eligibility_unavailable',
				message: 'Widgets subscription eligibility could not be confirmed'
			}
		});
	});
	it.each([
		'',
		' owner',
		'owner ',
		'two owners',
		'a'.repeat(257),
		'owner\n'
	])('rejects noncanonical subjects before reading', async subject => {
		await expect(service.read(subject)).rejects.toThrow(
			BadRequestException
		);
		expect(read).not.toHaveBeenCalled();
	});
});
