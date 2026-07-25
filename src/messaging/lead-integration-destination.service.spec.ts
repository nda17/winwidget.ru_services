import {
	IntegrationDestinationError,
	LeadIntegrationDestinationService
} from '@/messaging/lead-integration-destination.service';
import {
	getLeadTargetFingerprint,
	LeadIntegrationEventPayloadV2
} from '@/messaging/lead-integration-event';
import type { PrismaService } from '@/prisma.service';

describe('LeadIntegrationDestinationService', () => {
	const eventId = '11111111-1111-4111-8111-111111111111';
	const credentialRef = '22222222-2222-4222-8222-222222222222';
	const base = {
		integration: 'amo-crm' as const,
		source: 'widget' as const,
		entity: { id: 'widget-1', name: 'Колесо' },
		lead: {
			id: 'lead-1',
			createdAt: '2026-07-25T00:00:00.000Z'
		}
	};
	const eventV2: LeadIntegrationEventPayloadV2 = {
		...base,
		schemaVersion: 2,
		eventType: 'lead.integration.requested.v2',
		destination: { credentialRef }
	};

	const createService = () => {
		const prisma = {
			integrationCredentialSnapshot: {
				findFirst: jest.fn(),
				update: jest.fn(),
				deleteMany: jest.fn()
			},
			widget: {
				findUnique: jest.fn()
			}
		} as unknown as PrismaService;
		return {
			service: new LeadIntegrationDestinationService(prisma),
			prisma
		};
	};

	it('resolves credentials from PostgreSQL without exposing them in the event', async () => {
		const { service, prisma } = createService();
		(
			prisma.integrationCredentialSnapshot.findFirst as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			credentials: {
				amoCrmDomain: 'example.amocrm.ru',
				amoCrmToken: 'secret-token'
			}
		});

		const resolved = await service.resolve(eventId, eventV2);

		expect(resolved.destination).toEqual({
			amoCrmDomain: 'example.amocrm.ru',
			amoCrmToken: 'secret-token'
		});
		expect(JSON.stringify(eventV2)).not.toContain('secret-token');
	});

	it('refreshes an auth credential only when the logical target is unchanged', async () => {
		const { service, prisma } = createService();
		const targetFingerprint = getLeadTargetFingerprint('amo-crm', {
			amoCrmDomain: 'example.amocrm.ru',
			amoCrmToken: 'old-token'
		});
		(prisma.widget.findUnique as jest.Mock).mockResolvedValue({
			config: {
				integrations: {
					amoCrmDomain: 'example.amocrm.ru',
					amoCrmToken: 'new-token'
				}
			}
		});
		(
			prisma.integrationCredentialSnapshot.findFirst as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			targetFingerprint
		});

		await service.refreshSnapshotFromCurrentConfig(eventId, eventV2);

		expect(
			prisma.integrationCredentialSnapshot.update
		).toHaveBeenCalledWith({
			where: { id: credentialRef },
			data: {
				credentials: {
					amoCrmDomain: 'example.amocrm.ru',
					amoCrmToken: 'new-token'
				},
				version: { increment: 1 }
			}
		});
	});

	it('blocks a manual retry from redirecting an old lead to another target', async () => {
		const { service, prisma } = createService();
		(prisma.widget.findUnique as jest.Mock).mockResolvedValue({
			config: {
				integrations: {
					amoCrmDomain: 'another.amocrm.ru',
					amoCrmToken: 'new-token'
				}
			}
		});
		(
			prisma.integrationCredentialSnapshot.findFirst as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			targetFingerprint: getLeadTargetFingerprint('amo-crm', {
				amoCrmDomain: 'example.amocrm.ru',
				amoCrmToken: 'old-token'
			})
		});

		await expect(
			service.refreshSnapshotFromCurrentConfig(eventId, eventV2)
		).rejects.toMatchObject<Partial<IntegrationDestinationError>>({
			code: 'DESTINATION_TARGET_CHANGED'
		});
		expect(
			prisma.integrationCredentialSnapshot.update
		).not.toHaveBeenCalled();
	});
});
