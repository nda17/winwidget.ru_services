import { getClientIp } from '@/utils/ip.util';
import type { Request } from 'express';

describe('getClientIp', () => {
	it('ignores spoofed proxy headers in favor of request.ip', () => {
		const request = {
			ip: '203.0.113.10',
			headers: {
				'x-forwarded-for': '198.51.100.1, 10.0.0.1',
				'x-real-ip': '198.51.100.2',
				'cf-connecting-ip': '198.51.100.3'
			},
			socket: {
				remoteAddress: '127.0.0.1'
			}
		} as unknown as Request;

		expect(getClientIp(request)).toBe('203.0.113.10');
	});

	it('falls back to the socket address without trusting proxy headers', () => {
		const request = {
			ip: undefined,
			headers: {
				'x-forwarded-for': '198.51.100.1',
				'x-real-ip': '198.51.100.2',
				'cf-connecting-ip': '198.51.100.3'
			},
			socket: {
				remoteAddress: '127.0.0.1'
			}
		} as unknown as Request;

		expect(getClientIp(request)).toBe('127.0.0.1');
	});
});
