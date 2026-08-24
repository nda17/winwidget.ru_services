import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { IdentityIntrospectionClient } from './identity-introspection.client';

describe('IdentityIntrospectionClient', () => {
	const runtime = { apiEnabled: true } as OperationsRuntimeService;
	const config = (values: Record<string, string>) =>
		({
			get: jest.fn((key: string) => values[key])
		}) as unknown as ConfigService;

	it('rejects the documented placeholder credential for the API role', () => {
		expect(
			() =>
				new IdentityIntrospectionClient(
					config({
						IDENTITY_OPERATIONS_TOKEN:
							'change_me_operations_identity_token_at_least_32_chars'
					}),
					runtime
				)
		).toThrow('non-placeholder secret');
	});

	it('rejects a non-loopback Identity URL', () => {
		expect(
			() =>
				new IdentityIntrospectionClient(
					config({
						IDENTITY_INTERNAL_BASE_URL: 'https://identity.example.test',
						IDENTITY_OPERATIONS_TOKEN: 'a'.repeat(32)
					}),
					runtime
				)
		).toThrow('exact loopback http origin');
	});

	it('fails closed when Identity cannot be reached', async () => {
		const originalFetch = global.fetch;
		global.fetch = jest.fn().mockRejectedValue(new Error('network'));
		try {
			const client = new IdentityIntrospectionClient(
				config({ IDENTITY_OPERATIONS_TOKEN: 'a'.repeat(32) }),
				runtime
			);
			await expect(
				client.introspect('Bearer access-token')
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		} finally {
			global.fetch = originalFetch;
		}
	});
});
