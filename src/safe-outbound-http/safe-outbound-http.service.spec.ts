import { SafeOutboundHttpService } from './safe-outbound-http.service';
import { BadRequestException } from '@nestjs/common';
import * as dnsPromises from 'dns/promises';
import * as undici from 'undici';

const response = (statusCode: number, location?: string) =>
	({
		statusCode,
		headers: location ? { location } : {},
		body: { dump: jest.fn().mockResolvedValue(undefined) }
	}) as any;

describe('SafeOutboundHttpService', () => {
	let service: SafeOutboundHttpService;

	beforeEach(() => {
		service = new SafeOutboundHttpService();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it.each([
		'8.8.8.8',
		'1.1.1.1',
		'2606:4700:4700::1111',
		'2001:4860:4860::8888'
	])('разрешает публичный IP %s', address => {
		expect(service.isPublicIpAddress(address)).toBe(true);
	});

	it.each([
		'0.0.0.0',
		'10.0.0.1',
		'100.64.0.1',
		'127.0.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'192.168.0.1',
		'198.18.0.1',
		'224.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'::7f00:1',
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
		'2001:0000:4136:e378:8000:63bf:3fff:fdd2',
		'3fff::1',
		'3ffe::1',
		'4000::1',
		'5f00::1'
	])('блокирует непубличный IP %s', address => {
		expect(service.isPublicIpAddress(address)).toBe(false);
	});

	it('отклоняет DNS-имя со смешанными публичными и private адресами', async () => {
		jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([
			{ address: '8.8.8.8', family: 4 },
			{ address: '10.0.0.1', family: 4 }
		] as any);

		await expect(
			service.validateIntegrationConfig({
				webhookUrl: 'https://hooks.example.test/lead'
			})
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('разрешает только согласованные публичные порты', async () => {
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

	it('нормализует официальный amoCRM и Kommo endpoint', () => {
		expect(service.getAmoCrmApiUrl('company')).toBe(
			'https://company.amocrm.ru/api/v4/leads/complex'
		);
		expect(service.getAmoCrmApiUrl('tenant.kommo.com')).toBe(
			'https://tenant.kommo.com/api/v4/leads/complex'
		);
		expect(service.getAmoCrmApiUrl('http://tenant.amocrm.ru')).toBe(
			'https://tenant.amocrm.ru/api/v4/leads/complex'
		);
		expect(() =>
			service.getAmoCrmApiUrl('tenant.amocrm.ru.evil.test')
		).toThrow(BadRequestException);
	});

	it('блокирует redirect на внутренний адрес до второго HTTP-запроса', async () => {
		const requestSpy = jest
			.spyOn(undici, 'request')
			.mockResolvedValue(response(302, 'http://127.0.0.1/internal'));

		await expect(
			service.postJson(
				'https://8.8.8.8/lead',
				{ phone: '+79991234567' },
				{ policy: 'webhook' }
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(requestSpy).toHaveBeenCalledTimes(1);
	});

	it('повторно проверяет публичный redirect и завершает запрос', async () => {
		const requestSpy = jest
			.spyOn(undici, 'request')
			.mockResolvedValueOnce(response(307, 'https://1.1.1.1/next'))
			.mockResolvedValueOnce(response(204));

		await expect(
			service.postJson(
				'https://8.8.8.8/lead',
				{ email: 'lead@example.com' },
				{ policy: 'webhook' }
			)
		).resolves.toBeUndefined();
		expect(requestSpy).toHaveBeenCalledTimes(2);
	});

	it('запрещает больше двух перенаправлений', async () => {
		jest
			.spyOn(undici, 'request')
			.mockResolvedValueOnce(response(302, 'https://1.1.1.1/one'))
			.mockResolvedValueOnce(response(302, 'https://8.8.4.4/two'))
			.mockResolvedValueOnce(response(302, 'https://9.9.9.9/three'));

		await expect(
			service.postJson('https://8.8.8.8/lead', {}, { policy: 'webhook' })
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
