import { BadRequestException } from '@nestjs/common';
import { BillingSettingsService } from './billing-settings.service';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from './billing-legal.constants';
import { YOOKASSA_RECEIPT_CONTRACT } from '../provider/yookassa.service';

const settings = (overrides: Record<string, unknown> = {}) => ({
	id: 'singleton',
	paymentEnabled: true,
	autoRenewalSignupEnabled: false,
	autoRenewalChargesEnabled: false,
	autoRenewalChargesEnabledAt: new Date('2026-08-01T00:00:00.000Z'),
	affiliateProgramEnabled: true,
	affiliateCashbackPercent: 10,
	aggregateVersion: 5n,
	sourceSequence: 10n,
	updatedAt: new Date('2026-08-23T12:00:00.000Z'),
	...overrides
});

describe('BillingSettingsService', () => {
	const originalFetch = global.fetch;
	const originalRevision = process.env.APP_REVISION;

	afterEach(() => {
		global.fetch = originalFetch;
		if (originalRevision === undefined) delete process.env.APP_REVISION;
		else process.env.APP_REVISION = originalRevision;
		jest.restoreAllMocks();
	});

	it('returns the exact narrow public response', async () => {
		const prisma = {
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings())
			}
		};
		const service = new BillingSettingsService(prisma as never);
		await expect(service.publicSettings()).resolves.toEqual({
			paymentEnabled: true,
			autoRenewalSignupEnabled: false,
			autoRenewalTerms: {
				version: AUTO_RENEWAL_CONSENT_VERSION,
				text: AUTO_RENEWAL_CONSENT_TEXT
			}
		});
	});

	it('returns the exact non-null admin response', async () => {
		const prisma = {
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings())
			}
		};
		const service = new BillingSettingsService(prisma as never);
		const result = await service.adminSettings();
		expect(result).toEqual({
			id: 'singleton',
			paymentEnabled: true,
			autoRenewalSignupEnabled: false,
			autoRenewalChargesEnabled: false,
			autoRenewalChargesEnabledAt: '2026-08-01T00:00:00.000Z',
			affiliateProgramEnabled: true,
			affiliateCashbackPercent: 10,
			autoRenewalTerms: {
				version: AUTO_RENEWAL_CONSENT_VERSION,
				text: AUTO_RENEWAL_CONSENT_TEXT
			},
			updatedAt: '2026-08-23T12:00:00.000Z'
		});
	});

	it('returns code/config readiness without credential values or merchant claims', async () => {
		process.env.APP_REVISION = 'billing-test-revision';
		const prisma = {
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings())
			}
		};
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: jest.fn().mockResolvedValue({
				status: 'ready',
				service: 'billing',
				role: 'worker',
				revision: 'billing-test-revision',
				providerConfiguration: {
					yookassa: {
						mode: 'production',
						shopIdConfigured: true,
						secretKeyConfigured: true,
						credentialsConfigured: true
					},
					paymentMethodEncryptionKeyConfigured: true
				}
			})
		}) as unknown as typeof fetch;
		const service = new BillingSettingsService(prisma as never);

		const result = await service.providerReadiness();

		expect(result).toEqual({
			schemaVersion: 1,
			source: 'CODE_AND_PERSISTED_SETTINGS',
			provider: {
				name: 'YOOKASSA',
				mode: 'production',
				shopIdConfigured: true,
				secretKeyConfigured: true,
				credentialsConfigured: true
			},
			features: {
				paymentEnabled: true,
				autoRenewalSignupEnabled: false,
				autoRenewalChargesEnabled: false
			},
			receipt: YOOKASSA_RECEIPT_CONTRACT,
			webhook: {
				codeConfigured: true,
				method: 'POST',
				route: '/api/v1/payments/webhook',
				acceptedEvents: ['payment.succeeded', 'payment.canceled'],
				duplicateDeliveryFence:
					'authenticated-provider-object-reverification'
			},
			externalVerification: {
				merchantAutoPayments: 'NOT_VERIFIED',
				onlineCashRegister: 'NOT_VERIFIED',
				ofd: 'NOT_VERIFIED'
			}
		});
		expect(JSON.stringify(result)).not.toContain('shop-secret');
		expect(JSON.stringify(result)).not.toContain('shop-id-value');
		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:4802/health/ready',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});

	it('fails closed when worker provider readiness cannot be verified', async () => {
		process.env.APP_REVISION = 'billing-test-revision';
		const prisma = {
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings())
			}
		};
		global.fetch = jest
			.fn()
			.mockRejectedValue(new Error('worker unavailable'));
		const service = new BillingSettingsService(prisma as never);

		await expect(service.providerReadiness()).rejects.toThrow(
			'Billing worker readiness is unavailable'
		);
	});

	it.each([
		{
			name: 'wrong service identity',
			patch: { service: 'other-service' }
		},
		{
			name: 'wrong worker revision',
			patch: { revision: 'stale-revision' }
		},
		{
			name: 'missing encryption key',
			patch: { paymentMethodEncryptionKeyConfigured: false }
		},
		{
			name: 'unconfigured provider',
			patch: {
				yookassa: {
					mode: 'production',
					shopIdConfigured: true,
					secretKeyConfigured: false,
					credentialsConfigured: false
				}
			}
		}
	])('fails closed for $name', async ({ patch }) => {
		process.env.APP_REVISION = 'billing-test-revision';
		const providerConfiguration = {
			yookassa: {
				mode: 'production',
				shopIdConfigured: true,
				secretKeyConfigured: true,
				credentialsConfigured: true
			},
			paymentMethodEncryptionKeyConfigured: true,
			...(patch.yookassa ? { yookassa: patch.yookassa } : {}),
			...(patch.paymentMethodEncryptionKeyConfigured === false
				? { paymentMethodEncryptionKeyConfigured: false }
				: {})
		};
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: jest.fn().mockResolvedValue({
				status: 'ready',
				service: patch.service || 'billing',
				role: 'worker',
				revision: patch.revision || 'billing-test-revision',
				providerConfiguration
			})
		}) as unknown as typeof fetch;
		const service = new BillingSettingsService({
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings())
			}
		} as never);

		await expect(service.providerReadiness()).rejects.toThrow(
			'Billing worker readiness is unavailable'
		);
	});

	it('updates settings and audit in one transaction', async () => {
		const updated = settings({
			paymentEnabled: false,
			affiliateCashbackPercent: 15,
			aggregateVersion: 6n,
			sourceSequence: 11n
		});
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings()),
				update: jest.fn().mockResolvedValue(updated)
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 12n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest
				.fn()
				.mockImplementation((work: (tx: unknown) => unknown) =>
					work(transaction)
				)
		};
		const service = new BillingSettingsService(prisma as never);

		const result = await service.updateAdminSettings(
			{ paymentEnabled: false, affiliateCashbackPercent: 15 },
			{
				actor: {
					active: true,
					subject: 'admin-1',
					sessionId: 'session-1',
					roles: ['ADMIN']
				},
				ip: '1'.repeat(200),
				userAgent: 'u'.repeat(600)
			}
		);

		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					metadata: expect.objectContaining({
						requestIp: '1'.repeat(128),
						requestUserAgent: 'u'.repeat(500)
					})
				})
			})
		});
		expect(result).toMatchObject({
			id: 'singleton',
			paymentEnabled: false,
			affiliateCashbackPercent: 15,
			autoRenewalTerms: {
				version: AUTO_RENEWAL_CONSENT_VERSION,
				text: AUTO_RENEWAL_CONSENT_TEXT
			}
		});
	});

	it('rejects an empty PATCH before opening a transaction', async () => {
		const prisma = { $transaction: jest.fn() };
		const service = new BillingSettingsService(prisma as never);
		await expect(
			service.updateAdminSettings(
				{},
				{
					actor: {
						active: true,
						subject: 'admin-1',
						sessionId: 'session-1',
						roles: ['ADMIN']
					}
				}
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
});
