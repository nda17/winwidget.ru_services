import {
	getCredentialSnapshotData,
	getLeadTargetFingerprint,
	LeadIntegrationConfigSnapshot,
	LeadIntegrationEventPayload,
	LeadIntegrationEventPayloadV2,
	LeadSource,
	ResolvedLeadIntegrationEventPayload,
	ResolvedLeadIntegrationDestination
} from '@/messaging/lead-integration-event';
import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export class IntegrationDestinationError extends Error {
	constructor(
		public readonly code:
			| 'DESTINATION_SNAPSHOT_MISSING'
			| 'DESTINATION_SNAPSHOT_INVALID'
			| 'DESTINATION_CONFIGURATION_MISSING'
			| 'DESTINATION_TARGET_CHANGED',
		message: string
	) {
		super(message);
		this.name = 'IntegrationDestinationError';
	}
}

@Injectable()
export class LeadIntegrationDestinationService {
	constructor(private readonly prisma: PrismaService) {}

	async resolve(
		eventId: string,
		event: LeadIntegrationEventPayload
	): Promise<ResolvedLeadIntegrationEventPayload> {
		if (
			event.integration === 'email' &&
			'email' in event.destination &&
			event.destination.email
		) {
			return {
				...event,
				destination: { email: event.destination.email }
			};
		}
		if (
			event.integration === 'telegram' &&
			'telegramChatId' in event.destination &&
			event.destination.telegramChatId
		) {
			return {
				...event,
				destination: {
					telegramChatId: event.destination.telegramChatId
				}
			};
		}
		if (!('credentialRef' in event.destination)) {
			throw new IntegrationDestinationError(
				'DESTINATION_SNAPSHOT_INVALID',
				'Integration destination reference is invalid'
			);
		}

		const snapshot =
			await this.prisma.integrationCredentialSnapshot.findFirst({
				where: {
					id: event.destination.credentialRef,
					eventId,
					integration: event.integration,
					source: event.source,
					entityId: event.entity.id
				}
			});
		if (!snapshot) {
			throw new IntegrationDestinationError(
				'DESTINATION_SNAPSHOT_MISSING',
				'Integration destination snapshot is missing'
			);
		}

		return {
			...event,
			destination: this.parseSnapshotCredentials(
				event.integration,
				snapshot.credentials
			)
		};
	}

	async refreshSnapshotFromCurrentConfig(
		eventId: string,
		event: LeadIntegrationEventPayloadV2,
		transaction?: Prisma.TransactionClient
	): Promise<void> {
		if (
			event.integration === 'email' ||
			event.integration === 'telegram' ||
			!('credentialRef' in event.destination)
		) {
			return;
		}

		const client = transaction || this.prisma;
		const integrations = await this.getCurrentIntegrations(
			event.source,
			event.entity.id,
			client
		);
		const destination = this.getDestinationFromConfig(
			event.integration,
			integrations
		);
		const currentFingerprint = getLeadTargetFingerprint(
			event.integration,
			destination
		);
		const snapshot = await client.integrationCredentialSnapshot.findFirst({
			where: {
				id: event.destination.credentialRef,
				eventId,
				integration: event.integration
			}
		});
		if (!snapshot) {
			throw new IntegrationDestinationError(
				'DESTINATION_SNAPSHOT_MISSING',
				'Integration destination snapshot is missing'
			);
		}
		if (snapshot.targetFingerprint !== currentFingerprint) {
			throw new IntegrationDestinationError(
				'DESTINATION_TARGET_CHANGED',
				'Integration destination target has changed'
			);
		}

		const refreshed = getCredentialSnapshotData(
			eventId,
			event.integration,
			event.source,
			event.entity.id,
			destination
		);
		await client.integrationCredentialSnapshot.update({
			where: { id: snapshot.id },
			data: {
				credentials: refreshed.credentials,
				version: { increment: 1 }
			}
		});
	}

	private parseSnapshotCredentials(
		integration: LeadIntegrationEventPayload['integration'],
		value: Prisma.JsonValue
	): ResolvedLeadIntegrationDestination {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new IntegrationDestinationError(
				'DESTINATION_SNAPSHOT_INVALID',
				'Integration destination snapshot is invalid'
			);
		}
		const credentials = value as Record<string, unknown>;
		if (
			integration === 'webhook' &&
			typeof credentials.webhookUrl === 'string' &&
			credentials.webhookUrl
		) {
			return { webhookUrl: credentials.webhookUrl };
		}
		if (
			integration === 'bitrix24' &&
			typeof credentials.bitrix24WebhookUrl === 'string' &&
			credentials.bitrix24WebhookUrl
		) {
			return {
				bitrix24WebhookUrl: credentials.bitrix24WebhookUrl
			};
		}
		if (
			integration === 'amo-crm' &&
			typeof credentials.amoCrmDomain === 'string' &&
			credentials.amoCrmDomain &&
			typeof credentials.amoCrmToken === 'string' &&
			credentials.amoCrmToken
		) {
			return {
				amoCrmDomain: credentials.amoCrmDomain,
				amoCrmToken: credentials.amoCrmToken
			};
		}
		throw new IntegrationDestinationError(
			'DESTINATION_SNAPSHOT_INVALID',
			'Integration destination snapshot is incomplete'
		);
	}

	private async getCurrentIntegrations(
		source: LeadSource,
		entityId: string,
		client: Prisma.TransactionClient | PrismaService
	): Promise<LeadIntegrationConfigSnapshot> {
		const select = { config: true } as const;
		const entity =
			source === 'widget'
				? await client.widget.findUnique({
						where: { id: entityId },
						select
					})
				: source === 'quiz'
					? await client.quiz.findUnique({
							where: { id: entityId },
							select
						})
					: source === 'callback'
						? await client.callback.findUnique({
								where: { id: entityId },
								select
							})
						: source === 'countdown-timer'
							? await client.countdownTimer.findUnique({
									where: { id: entityId },
									select
								})
							: source === 'stop-offer'
								? await client.stopOffer.findUnique({
										where: { id: entityId },
										select
									})
								: source === 'online-consultant'
									? await client.onlineConsultant.findUnique({
											where: { id: entityId },
											select
										})
									: await client.calculator.findUnique({
											where: { id: entityId },
											select
										});
		if (
			!entity?.config ||
			typeof entity.config !== 'object' ||
			Array.isArray(entity.config)
		) {
			throw new IntegrationDestinationError(
				'DESTINATION_CONFIGURATION_MISSING',
				'Current integration configuration is missing'
			);
		}
		const integrations = (entity.config as Record<string, unknown>)
			.integrations;
		if (
			!integrations ||
			typeof integrations !== 'object' ||
			Array.isArray(integrations)
		) {
			throw new IntegrationDestinationError(
				'DESTINATION_CONFIGURATION_MISSING',
				'Current integration configuration is missing'
			);
		}
		return integrations as LeadIntegrationConfigSnapshot;
	}

	private getDestinationFromConfig(
		integration: 'webhook' | 'bitrix24' | 'amo-crm',
		config: LeadIntegrationConfigSnapshot
	): ResolvedLeadIntegrationDestination {
		const destination =
			integration === 'webhook'
				? { webhookUrl: config.webhookUrl?.trim() }
				: integration === 'bitrix24'
					? {
							bitrix24WebhookUrl: config.bitrix24WebhookUrl?.trim()
						}
					: {
							amoCrmDomain: config.amoCrmDomain?.trim(),
							amoCrmToken: config.amoCrmToken?.trim()
						};
		const complete =
			integration === 'webhook'
				? Boolean(destination.webhookUrl)
				: integration === 'bitrix24'
					? Boolean(destination.bitrix24WebhookUrl)
					: Boolean(destination.amoCrmDomain && destination.amoCrmToken);
		if (!complete) {
			throw new IntegrationDestinationError(
				'DESTINATION_CONFIGURATION_MISSING',
				'Current integration configuration is incomplete'
			);
		}
		return destination;
	}
}
