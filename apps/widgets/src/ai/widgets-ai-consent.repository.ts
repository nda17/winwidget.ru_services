import { Injectable } from '@nestjs/common';
import {
	AiConsentReceipt,
	AiConsentReceiptStatus
} from '@prisma/widgets-client';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';

export interface CreateAiConsentReceiptInput {
	acceptanceId: string;
	widgetId: string;
	widgetPublicKey: string;
	ownerScope: string;
	configuredSiteHostname: string;
	requestHostname: string;
	publishedVersion: number;
	sessionScope: string;
	sourceScope: string;
	documentVersion: string;
	documentHash: string;
	statementText: string;
	privacyUrl: string;
	proofExpiresAt: Date;
	acceptedAt: Date;
}

export interface VerifyAiConsentReceiptInput {
	id: string;
	acceptanceId: string;
	now: Date;
}

export interface VerifiedAiConsentLookup {
	id: string;
	acceptanceId: string;
	widgetId: string;
	widgetPublicKey: string;
	ownerScope: string;
	configuredSiteHostname: string;
	requestHostname: string;
	publishedVersion: number;
	sessionScope: string;
	sourceScope: string;
	documentVersion: string;
	documentHash: string;
	statementText: string;
	privacyUrl: string;
}

@Injectable()
export class WidgetsAiConsentRepository {
	constructor(private readonly prisma: WidgetsPrismaService) {}

	createPending(
		input: CreateAiConsentReceiptInput
	): Promise<AiConsentReceipt> {
		return this.prisma.aiConsentReceipt.create({
			data: {
				...input,
				status: AiConsentReceiptStatus.PENDING,
				verifiedAt: null
			}
		});
	}

	findByAcceptanceId(
		acceptanceId: string
	): Promise<AiConsentReceipt | null> {
		return this.prisma.aiConsentReceipt.findUnique({
			where: { acceptanceId }
		});
	}

	findById(id: string): Promise<AiConsentReceipt | null> {
		return this.prisma.aiConsentReceipt.findUnique({ where: { id } });
	}

	async verifyPending(
		input: VerifyAiConsentReceiptInput
	): Promise<AiConsentReceipt | null> {
		const result = await this.prisma.aiConsentReceipt.updateMany({
			where: {
				id: input.id,
				acceptanceId: input.acceptanceId,
				status: AiConsentReceiptStatus.PENDING,
				proofExpiresAt: { gt: input.now }
			},
			data: {
				status: AiConsentReceiptStatus.VERIFIED,
				verifiedAt: input.now,
				updatedAt: input.now
			}
		});
		if (result.count !== 1) return null;
		return this.findById(input.id);
	}

	findVerifiedByIdAndEvidence(
		input: VerifiedAiConsentLookup
	): Promise<AiConsentReceipt | null> {
		return this.prisma.aiConsentReceipt.findFirst({
			where: {
				...input,
				status: AiConsentReceiptStatus.VERIFIED,
				verifiedAt: { not: null }
			}
		});
	}
}
