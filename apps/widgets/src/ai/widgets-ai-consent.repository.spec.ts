import { AiConsentReceiptStatus } from '@prisma/widgets-client';
import { WidgetsAiConsentRepository } from './widgets-ai-consent.repository';

const acceptedAt = new Date('2026-08-30T12:00:00.000Z');
const proofExpiresAt = new Date('2026-08-30T12:15:00.000Z');
const input = {
	acceptanceId: '22222222-2222-4222-8222-222222222222',
	widgetId: 'widget-1',
	widgetPublicKey: 'publicKey_12',
	ownerScope: 'o'.repeat(43),
	configuredSiteHostname: 'client.example',
	requestHostname: 'client.example',
	publishedVersion: 3,
	sessionScope: 's'.repeat(43),
	sourceScope: 'r'.repeat(43),
	documentVersion: 'ai-consent-v1',
	documentHash: 'a'.repeat(64),
	statementText: 'Я согласен на обработку вопроса AI-консультантом.',
	privacyUrl: 'https://client.example/privacy',
	proofExpiresAt,
	acceptedAt
};

const record = {
	id: '11111111-1111-4111-8111-111111111111',
	...input,
	status: AiConsentReceiptStatus.PENDING,
	verifiedAt: null,
	createdAt: acceptedAt,
	updatedAt: acceptedAt
};

const setup = () => {
	const aiConsentReceipt = {
		create: jest.fn().mockResolvedValue(record),
		findUnique: jest.fn().mockResolvedValue(record),
		findFirst: jest.fn().mockResolvedValue(record),
		updateMany: jest.fn().mockResolvedValue({ count: 1 })
	};
	const repository = new WidgetsAiConsentRepository({
		aiConsentReceipt
	} as never);
	return { repository, aiConsentReceipt };
};

describe('WidgetsAiConsentRepository', () => {
	it('creates only a pending receipt with no verification timestamp', async () => {
		const { repository, aiConsentReceipt } = setup();

		await expect(repository.createPending(input)).resolves.toBe(record);
		expect(aiConsentReceipt.create).toHaveBeenCalledWith({
			data: {
				...input,
				status: AiConsentReceiptStatus.PENDING,
				verifiedAt: null
			}
		});
	});

	it('finds receipts only by their unique identifiers', async () => {
		const { repository, aiConsentReceipt } = setup();

		await repository.findByAcceptanceId(input.acceptanceId);
		await repository.findById(record.id);

		expect(aiConsentReceipt.findUnique).toHaveBeenNthCalledWith(1, {
			where: { acceptanceId: input.acceptanceId }
		});
		expect(aiConsentReceipt.findUnique).toHaveBeenNthCalledWith(2, {
			where: { id: record.id }
		});
	});

	it('atomically verifies a pending unexpired receipt', async () => {
		const { repository, aiConsentReceipt } = setup();
		const now = new Date('2026-08-30T12:05:00.000Z');

		await expect(
			repository.verifyPending({
				id: record.id,
				acceptanceId: input.acceptanceId,
				now
			})
		).resolves.toBe(record);
		expect(aiConsentReceipt.updateMany).toHaveBeenCalledWith({
			where: {
				id: record.id,
				acceptanceId: input.acceptanceId,
				status: AiConsentReceiptStatus.PENDING,
				proofExpiresAt: { gt: now }
			},
			data: {
				status: AiConsentReceiptStatus.VERIFIED,
				verifiedAt: now,
				updatedAt: now
			}
		});
		expect(aiConsentReceipt.findUnique).toHaveBeenCalledWith({
			where: { id: record.id }
		});
	});

	it('returns null without a follow-up read when the CAS loses', async () => {
		const { repository, aiConsentReceipt } = setup();
		aiConsentReceipt.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			repository.verifyPending({
				id: record.id,
				acceptanceId: input.acceptanceId,
				now: new Date('2026-08-30T12:15:00.000Z')
			})
		).resolves.toBeNull();
		expect(aiConsentReceipt.findUnique).not.toHaveBeenCalled();
	});

	it('requires a verified status and the complete expected evidence', async () => {
		const { repository, aiConsentReceipt } = setup();
		const evidence = {
			id: record.id,
			acceptanceId: input.acceptanceId,
			widgetId: input.widgetId,
			widgetPublicKey: input.widgetPublicKey,
			ownerScope: input.ownerScope,
			configuredSiteHostname: input.configuredSiteHostname,
			requestHostname: input.requestHostname,
			publishedVersion: input.publishedVersion,
			sessionScope: input.sessionScope,
			sourceScope: input.sourceScope,
			documentVersion: input.documentVersion,
			documentHash: input.documentHash,
			statementText: input.statementText,
			privacyUrl: input.privacyUrl
		};

		await repository.findVerifiedByIdAndEvidence(evidence);

		expect(aiConsentReceipt.findFirst).toHaveBeenCalledWith({
			where: {
				...evidence,
				status: AiConsentReceiptStatus.VERIFIED,
				verifiedAt: { not: null }
			}
		});
	});
});
