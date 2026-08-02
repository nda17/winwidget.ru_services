import { CoreInternalClient } from './core-internal.client';
import {
	BadRequestException,
	ConflictException,
	ServiceUnavailableException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const TOKEN = 'reporting-test-token-at-least-32-characters';

function config(values: Record<string, string>) {
	return {
		get: jest.fn((key: string) => values[key])
	} as unknown as ConfigService;
}

function client(overrides: Record<string, string> = {}) {
	return new CoreInternalClient(
		config({
			REPORTING_INTERNAL_TOKEN: TOKEN,
			REPORTING_CORE_INTERNAL_BASE_URL: 'http://127.0.0.1:4200',
			...overrides
		}),
		{ apiEnabled: true, backfillEnabled: false } as never
	);
}

describe('CoreInternalClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		'http://core:4200',
		'http://10.0.0.2:4200',
		'https://127.0.0.1:4200',
		'http://127.0.0.1:4200/base'
	])('rejects non-loopback or non-origin URL %s', url => {
		expect(() =>
			client({ REPORTING_CORE_INTERNAL_BASE_URL: url })
		).toThrow('REPORTING_CORE_INTERNAL_BASE_URL');
	});

	it('forwards bearer, service token and correlation ID', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: 'admin-id',
					sessionId: 'session-id',
					roles: ['ADMIN']
				}),
				{ status: 200 }
			)
		);
		await client().introspect(
			'Bearer user-token',
			'22222222-2222-4222-8222-222222222222'
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4200/api/v1/internal/reporting/auth/introspect',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer user-token',
					'x-winwidget-internal-token': TOKEN,
					'x-correlation-id': '22222222-2222-4222-8222-222222222222'
				})
			})
		);
	});

	it('fails closed when introspection is unavailable', async () => {
		jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
		await expect(
			client().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('reserves and confirms the Core backup-policy fence over loopback', async () => {
		const changeId = '33333333-3333-4333-8333-333333333333';
		const reservation = {
			accepted: true,
			changeId,
			reservationGeneration: '8',
			confirmationRequired: true
		};
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify(reservation), { status: 200 })
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						confirmed: true,
						changeId,
						reservationGeneration: '8'
					}),
					{ status: 200 }
				)
			);

		await expect(
			client().reserveDailySummarySchedulePolicy(
				changeId,
				'02:10',
				'7',
				'admin-id',
				'22222222-2222-4222-8222-222222222222'
			)
		).resolves.toEqual(reservation);
		await expect(
			client().confirmDailySummarySchedulePolicy(
				changeId,
				'8',
				'22222222-2222-4222-8222-222222222222'
			)
		).resolves.toEqual(
			expect.objectContaining({ confirmed: true, changeId })
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			'http://127.0.0.1:4200/api/v1/internal/reporting/schedule-policy',
			expect.objectContaining({
				method: 'PUT',
				body: JSON.stringify({
					changeId,
					scheduleTime: '02:10',
					expectedScheduleGeneration: '7',
					actorId: 'admin-id'
				}),
				headers: expect.objectContaining({
					'x-winwidget-internal-token': TOKEN,
					'x-correlation-id': '22222222-2222-4222-8222-222222222222'
				})
			})
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			'http://127.0.0.1:4200/api/v1/internal/reporting/schedule-policy/confirm',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					changeId,
					scheduleGeneration: '8'
				})
			})
		);
	});

	it.each([
		[400, BadRequestException],
		[409, ConflictException],
		[500, ServiceUnavailableException]
	])(
		'maps backup schedule policy HTTP %i fail closed',
		async (status, error) => {
			jest
				.spyOn(global, 'fetch')
				.mockResolvedValue(new Response(null, { status }));

			await expect(
				client().reserveDailySummarySchedulePolicy(
					'33333333-3333-4333-8333-333333333333',
					'02:10',
					'7',
					'admin-id'
				)
			).rejects.toBeInstanceOf(error);
		}
	);

	it('rejects an unknown or malformed policy reservation response', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					accepted: true,
					changeId: '33333333-3333-4333-8333-333333333333',
					reservationGeneration: -1,
					confirmationRequired: true
				}),
				{ status: 200 }
			)
		);

		await expect(
			client().reserveDailySummarySchedulePolicy(
				'33333333-3333-4333-8333-333333333333',
				'02:10',
				'7',
				'admin-id'
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
