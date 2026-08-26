import { OperationsInternalClient } from './operations-internal.client';
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
	return new OperationsInternalClient(
		config({
			REPORTING_INTERNAL_TOKEN: TOKEN,
			OPERATIONS_INTERNAL_BASE_URL: 'http://127.0.0.1:5200',
			...overrides
		}),
		{ apiEnabled: true } as never
	);
}

describe('OperationsInternalClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it('does not accept the inbound Operations-to-Reporting credential', () => {
		expect(
			() =>
				new OperationsInternalClient(
					config({ REPORTING_OPERATIONS_TOKEN: TOKEN }),
					{ apiEnabled: true } as never
				)
		).toThrow('REPORTING_INTERNAL_TOKEN');
	});

	it.each([
		'http://operations:5200',
		'http://10.0.0.2:5200',
		'https://127.0.0.1:5200',
		'http://127.0.0.1:5200/base'
	])('rejects non-loopback or non-origin URL %s', url => {
		expect(() => client({ OPERATIONS_INTERNAL_BASE_URL: url })).toThrow(
			'OPERATIONS_INTERNAL_BASE_URL'
		);
	});

	it('uses the Operations loopback default when the base URL is omitted', async () => {
		const changeId = '33333333-3333-4333-8333-333333333333';
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					accepted: true,
					changeId,
					reservationGeneration: '8',
					confirmationRequired: true
				}),
				{ status: 200 }
			)
		);
		await new OperationsInternalClient(
			config({ REPORTING_INTERNAL_TOKEN: TOKEN }),
			{ apiEnabled: true } as never
		).reserveDailySummarySchedulePolicy(
			changeId,
			'02:10',
			'7',
			'admin-id'
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:5200/internal/v1/operations/reporting/schedule-policy',
			expect.any(Object)
		);
	});

	it('reserves and confirms the backup-policy fence through Operations', async () => {
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
			'http://127.0.0.1:5200/internal/v1/operations/reporting/schedule-policy',
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
			'http://127.0.0.1:5200/internal/v1/operations/reporting/schedule-policy/confirm',
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
