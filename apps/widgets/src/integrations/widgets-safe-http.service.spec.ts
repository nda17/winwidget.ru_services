import { BadRequestException } from '@nestjs/common';
import {
	WidgetsSafeHttpError,
	WidgetsSafeHttpService
} from './widgets-safe-http.service';

interface SafeHttpTestAccess {
	requestOnce: (...args: unknown[]) => Promise<{
		status: number;
		headers: Record<string, string>;
		body: string;
	}>;
	lookupAddresses: (
		hostname: string
	) => Promise<Array<{ address: string; family: number }>>;
}

describe('WidgetsSafeHttpService', () => {
	let service: WidgetsSafeHttpService;

	beforeEach(() => {
		service = new WidgetsSafeHttpService();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it.each([
		'8.8.8.8',
		'1.1.1.1',
		'2606:4700:4700::1111',
		'2001:4860:4860::8888'
	])('allows public IP %s', address => {
		expect(service.isPublicIpAddress(address)).toBe(true);
	});

	it.each([
		'0.0.0.0',
		'10.0.0.1',
		'100.64.0.1',
		'127.0.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'192.0.0.1',
		'192.168.0.1',
		'198.18.0.1',
		'224.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'::ffff:127.0.0.1',
		'fc00::1',
		'fe80::1',
		'fec0::1',
		'ff02::1',
		'64:ff9b:1::1',
		'100::1',
		'2001:2::1',
		'2001:db8::1',
		'2002:7f00:1::',
		'3fff::1',
		'3ffe::1',
		'4000::1',
		'5f00::1'
	])('blocks non-public or reserved IP %s', address => {
		expect(service.isPublicIpAddress(address)).toBe(false);
	});

	it('rejects a hostname with mixed public and private DNS answers', async () => {
		jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'lookupAddresses')
			.mockResolvedValue([
				{ address: '8.8.8.8', family: 4 },
				{ address: '10.0.0.1', family: 4 }
			] as never);

		await expect(
			service.validateIntegrationConfig({
				webhookUrl: 'https://hooks.example.test/lead'
			})
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('bounds DNS lookup by the absolute request deadline', async () => {
		jest.useFakeTimers();
		jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'lookupAddresses')
			.mockReturnValue(new Promise(() => undefined));
		const result = expect(
			service.validateIntegrationConfig({
				webhookUrl: 'https://slow.example.test/lead'
			})
		).rejects.toThrow('TRANSPORT_TIMEOUT');

		await jest.advanceTimersByTimeAsync(5_001);
		await result;
	});

	it('preserves documented HTTP schemes and public ports', async () => {
		await expect(
			service.validateIntegrationConfig({
				webhookUrl: 'http://8.8.8.8:8080/lead'
			})
		).resolves.toBeUndefined();
		await expect(
			service.validateIntegrationConfig({
				webhookUrl: 'https://8.8.8.8:8443/lead'
			})
		).resolves.toBeUndefined();
		await expect(
			service.validateIntegrationConfig({
				webhookUrl: 'https://8.8.8.8:3000/lead'
			})
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('normalizes amoCRM shorthand and all documented official domains', () => {
		expect(service.amoApiUrl('company')).toBe(
			'https://company.amocrm.ru/api/v4/leads/complex'
		);
		expect(service.amoApiUrl('tenant.amocrm.com')).toBe(
			'https://tenant.amocrm.com/api/v4/leads/complex'
		);
		expect(service.amoApiUrl('tenant.kommo.com')).toBe(
			'https://tenant.kommo.com/api/v4/leads/complex'
		);
		expect(service.amoApiUrl('http://tenant.amocrm.ru')).toBe(
			'https://tenant.amocrm.ru/api/v4/leads/complex'
		);
		expect(() => service.amoApiUrl('tenant.amocrm.ru.evil.test')).toThrow(
			BadRequestException
		);
	});

	it('revalidates a redirect and blocks private destinations before the second request', async () => {
		const requestSpy = jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'requestOnce')
			.mockResolvedValue({
				status: 302,
				headers: { location: 'http://127.0.0.1/internal' },
				body: ''
			} as never);

		await expect(
			service.postJson(
				'https://8.8.8.8/lead',
				{ phone: '+79991234567' },
				{ policy: 'webhook' }
			)
		).rejects.toMatchObject({ providerCode: 'INVALID_DESTINATION' });
		expect(requestSpy).toHaveBeenCalledTimes(1);
	});

	it('revalidates a public redirect and preserves POST for 307', async () => {
		const requestSpy = jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'requestOnce')
			.mockResolvedValueOnce({
				status: 307,
				headers: { location: 'https://1.1.1.1/next' },
				body: ''
			} as never)
			.mockResolvedValueOnce({
				status: 204,
				headers: {},
				body: ''
			} as never);

		await expect(
			service.postJson(
				'https://8.8.8.8/lead',
				{ email: 'lead@example.com' },
				{ policy: 'webhook' }
			)
		).resolves.toBeUndefined();
		expect(requestSpy).toHaveBeenCalledTimes(2);
		expect(requestSpy.mock.calls[1][1]).toBe('POST');
	});

	it('returns a safe structured HTTP 429 error and Retry-After', async () => {
		jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'requestOnce')
			.mockResolvedValue({
				status: 429,
				headers: { 'retry-after': '12' },
				body: '{"error":"sensitive-value"}'
			} as never);

		const result = service.postJson(
			'https://8.8.8.8/private-path',
			{},
			{ policy: 'webhook' }
		);
		await expect(result).rejects.toMatchObject({
			provider: 'webhook',
			httpStatus: 429,
			providerCode: 'HTTP_429',
			retryAfterMs: 12_000,
			safeReason: 'Webhook request failed (HTTP_429)'
		});
		await expect(result).rejects.not.toThrow('sensitive-value');
		await expect(result).rejects.not.toThrow('private-path');
	});

	it('recognizes a Bitrix24 application error returned with HTTP 200', async () => {
		jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'requestOnce')
			.mockResolvedValue({
				status: 200,
				headers: {},
				body: JSON.stringify({
					error: 'QUERY_LIMIT_EXCEEDED',
					error_description: 'sensitive portal detail'
				})
			} as never);

		await expect(
			service.postJson(
				'https://8.8.8.8/rest/1/token/crm.lead.add.json',
				{},
				{
					policy: 'bitrix24'
				}
			)
		).rejects.toMatchObject({
			providerCode: 'QUERY_LIMIT_EXCEEDED',
			safeReason: 'Bitrix24 request failed (QUERY_LIMIT_EXCEEDED)'
		});
	});

	it('extracts only the safe amoCRM validation code', async () => {
		jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'lookupAddresses')
			.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
		jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'requestOnce')
			.mockResolvedValue({
				status: 400,
				headers: {},
				body: JSON.stringify({
					'validation-errors': [
						{
							errors: [
								{ code: 'NotSupportedChoice', detail: 'sensitive value' }
							]
						}
					]
				})
			} as never);

		await expect(
			service.postJson(
				'https://tenant.amocrm.ru/api/v4/leads/complex',
				{},
				{ policy: 'amo-crm' }
			)
		).rejects.toMatchObject({
			providerCode: 'NotSupportedChoice',
			safeReason: 'amoCRM request failed (NotSupportedChoice)'
		});
	});

	it('exposes only structured safe outbound errors', async () => {
		jest
			.spyOn(service as unknown as SafeHttpTestAccess, 'requestOnce')
			.mockRejectedValue(
				Object.assign(new Error('raw socket detail'), {
					code: 'ECONNRESET'
				})
			);
		await expect(
			service.postJson('https://8.8.8.8/lead', {}, { policy: 'webhook' })
		).rejects.toBeInstanceOf(WidgetsSafeHttpError);
	});
});
