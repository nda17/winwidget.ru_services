import { ServiceUnavailableException } from '@nestjs/common';
import {
	TaskSeriesAuthorityClient,
	type SeriesAuthorityRequest
} from './task-series-authority.client';

const request: SeriesAuthorityRequest = {
	schemaVersion: 1,
	workspaceId: '11111111-1111-4111-8111-111111111111',
	seriesId: '22222222-2222-4222-8222-222222222222',
	creatorBinding: { subject: 'owner', membershipId: null },
	assigneeBinding: { subject: 'owner', membershipId: null },
	template: { teamId: null, deal: null }
};
describe('series write-authority client', () => {
	const previousOrigin = process.env.CRM_ACCESS_INTERNAL_BASE_URL;
	const previousToken = process.env.CRM_ACCESS_CRM_SALES_TOKEN;
	const response = (patch: Record<string, unknown> = {}) =>
		new Response(
			JSON.stringify({
				schemaVersion: 1,
				workspaceId: request.workspaceId,
				seriesId: request.seriesId,
				allowed: true,
				reason: null,
				...patch
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	beforeEach(() => {
		process.env.CRM_ACCESS_INTERNAL_BASE_URL = 'http://127.0.0.1:4400';
		process.env.CRM_ACCESS_CRM_SALES_TOKEN =
			'unit-test-series-token-only-not-production';
	});
	afterEach(() => {
		jest.restoreAllMocks();
		if (previousOrigin === undefined)
			delete process.env.CRM_ACCESS_INTERNAL_BASE_URL;
		else process.env.CRM_ACCESS_INTERNAL_BASE_URL = previousOrigin;
		if (previousToken === undefined)
			delete process.env.CRM_ACCESS_CRM_SALES_TOKEN;
		else process.env.CRM_ACCESS_CRM_SALES_TOKEN = previousToken;
	});
	it('uses the internal write-authority contract without a stored user JWT', async () => {
		const fetch = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(response());
		expect(
			await new TaskSeriesAuthorityClient().authorize(request)
		).toEqual({ allowed: true, reason: null });
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:4400/internal/v1/crm-access/task-series-authority',
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				cache: 'no-store',
				body: JSON.stringify(request)
			})
		);
		expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty(
			'Authorization'
		);
	});
	it.each([
		{ workspaceId: request.seriesId },
		{ seriesId: request.workspaceId },
		{ allowed: true, reason: 'READ_ONLY' },
		{ allowed: false, reason: null },
		{ allowed: false, reason: 'UNKNOWN' },
		{ extra: true }
	])('fails closed on incompatible evidence %j', async patch => {
		jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(patch));
		await expect(
			new TaskSeriesAuthorityClient().authorize(request)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it('returns an explicit denied reason without converting an outage to allow', async () => {
		jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				response({ allowed: false, reason: 'READ_ONLY' })
			)
			.mockRejectedValueOnce(new Error('network'));
		const client = new TaskSeriesAuthorityClient();
		expect(await client.authorize(request)).toEqual({
			allowed: false,
			reason: 'READ_ONLY'
		});
		await expect(client.authorize(request)).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
});
