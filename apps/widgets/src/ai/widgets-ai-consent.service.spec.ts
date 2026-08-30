import {
	ConflictException,
	HttpException,
	UnauthorizedException
} from '@nestjs/common';
import {
	AiConsentReceipt,
	AiConsentReceiptStatus
} from '@prisma/widgets-client';
import { createHash } from 'node:crypto';
import type { WidgetEntity } from '../domain/widgets-domain.types';
import type {
	CreateAiConsentReceiptInput,
	VerifiedAiConsentLookup
} from './widgets-ai-consent.repository';
import {
	AI_CONSENT_DOCUMENT_VERSION,
	AI_CONSENT_STATEMENT_TEXT,
	WidgetsAiConsentService,
	type WidgetsAiConsentDocument,
	type WidgetsAiConsentInput,
	type WidgetsAiPreparedConsent
} from './widgets-ai-consent.service';
import type {
	WidgetsAiConsentClaims,
	WidgetsAiSessionClaims
} from './widgets-ai-session-token.service';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const PROOF_EXPIRES_AT = new Date('2026-08-30T12:15:00.000Z');
const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const ACCEPTANCE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'session_abcdef1234567890';
const PUBLIC_KEY = 'abcdef123456';
const IP = '203.0.113.7';
const HOSTNAME = 'shop.example.test';

const scopes = {
	ownerScope: 'o'.repeat(43),
	widgetScope: 'w'.repeat(43),
	sourceScope: 'i'.repeat(43),
	sessionScope: 's'.repeat(43)
};

const widget: WidgetEntity = {
	id: 'widget-1',
	userId: 'owner-1',
	publicKey: PUBLIC_KEY,
	name: 'AI-консультант',
	isActive: true,
	installDomain: HOSTNAME,
	config: {
		operatorName: 'Alex',
		instructionsPrompt: 'Отвечайте только по каталогу.',
		privacyUrl: 'https://shop.example.test/privacy'
	},
	draftConfig: null,
	draftInstallDomain: null,
	draftRevision: 3,
	publishedVersion: 3,
	publishedFromDraftRevision: 3,
	publishedAt: new Date('2026-08-30T10:00:00.000Z'),
	createdAt: new Date('2026-08-29T10:00:00.000Z'),
	updatedAt: new Date('2026-08-30T10:00:00.000Z')
};

const inputFor = (
	document: WidgetsAiConsentDocument
): WidgetsAiConsentInput => ({
	acceptanceId: ACCEPTANCE_ID,
	sessionId: SESSION_ID,
	accepted: true,
	documentVersion: document.documentVersion,
	documentHash: document.documentHash
});

const claimsFor = (
	document: WidgetsAiConsentDocument,
	overrides: Partial<WidgetsAiConsentClaims> = {}
): WidgetsAiConsentClaims => ({
	publicKey: PUBLIC_KEY,
	sessionId: SESSION_ID,
	publishedVersion: widget.publishedVersion,
	consentReceiptId: RECEIPT_ID,
	acceptanceId: ACCEPTANCE_ID,
	documentVersion: document.documentVersion,
	documentHash: document.documentHash,
	requestHostname: HOSTNAME,
	acceptedAt: NOW.getTime(),
	expiresAt: PROOF_EXPIRES_AT.getTime(),
	...scopes,
	...overrides
});

const receiptFor = (
	document: WidgetsAiConsentDocument,
	overrides: Partial<AiConsentReceipt> = {}
): AiConsentReceipt => ({
	id: RECEIPT_ID,
	acceptanceId: ACCEPTANCE_ID,
	widgetId: widget.id,
	widgetPublicKey: PUBLIC_KEY,
	ownerScope: scopes.ownerScope,
	configuredSiteHostname: HOSTNAME,
	requestHostname: HOSTNAME,
	publishedVersion: widget.publishedVersion,
	sessionScope: scopes.sessionScope,
	sourceScope: scopes.sourceScope,
	documentVersion: document.documentVersion,
	documentHash: document.documentHash,
	statementText: document.statementText,
	privacyUrl: document.privacyUrl,
	proofExpiresAt: PROOF_EXPIRES_AT,
	acceptedAt: NOW,
	status: AiConsentReceiptStatus.PENDING,
	verifiedAt: null,
	createdAt: NOW,
	updatedAt: NOW,
	...overrides
});

const setup = (selectedWidget: WidgetEntity = widget) => {
	const widgets = {
		findByPublicKey: jest.fn().mockResolvedValue(selectedWidget)
	};
	const receipts = {
		createPending: jest.fn(),
		findByAcceptanceId: jest.fn(),
		findById: jest.fn(),
		verifyPending: jest.fn(),
		findVerifiedByIdAndEvidence: jest.fn()
	};
	const tokens = {
		scopes: jest.fn().mockReturnValue(scopes),
		issueConsent: jest.fn().mockReturnValue({
			consentToken: 'signed-consent-token',
			expiresAt: PROOF_EXPIRES_AT.toISOString()
		}),
		verifyConsent: jest.fn(),
		assertWidget: jest.fn()
	};
	const service = new WidgetsAiConsentService(
		widgets as never,
		receipts as never,
		tokens as never
	);
	return { service, widgets, receipts, tokens };
};

describe('WidgetsAiConsentService', () => {
	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(NOW);
	});

	afterEach(() => jest.useRealTimers());

	it('builds a deterministic consent document and hashes its exact canonical evidence', () => {
		const { service } = setup();
		const first = service.publicDocument(widget, HOSTNAME);
		const second = service.publicDocument(widget, HOSTNAME);
		const canonical = JSON.stringify({
			documentVersion: AI_CONSENT_DOCUMENT_VERSION,
			statementText: AI_CONSENT_STATEMENT_TEXT,
			privacyUrl: 'https://shop.example.test/privacy',
			configuredSiteHostname: HOSTNAME,
			requestHostname: HOSTNAME,
			publishedVersion: widget.publishedVersion
		});

		expect(first).toEqual(second);
		expect(first).toEqual({
			documentVersion: AI_CONSENT_DOCUMENT_VERSION,
			documentHash: createHash('sha256').update(canonical).digest('hex'),
			statementText: AI_CONSENT_STATEMENT_TEXT,
			privacyUrl: 'https://shop.example.test/privacy'
		});
		expect(
			service.publicDocument(
				{ ...widget, publishedVersion: widget.publishedVersion + 1 },
				HOSTNAME
			).documentHash
		).not.toBe(first.documentHash);
	});

	it.each([
		['document version', { documentVersion: 'stale-consent-v1' }],
		['document hash', { documentHash: 'f'.repeat(64) }]
	])('fails closed on a mismatched %s', async (_label, mismatch) => {
		const { service, receipts, tokens } = setup();
		const document = service.publicDocument(widget, HOSTNAME);

		await expect(
			service.accept(
				PUBLIC_KEY,
				{ ...inputFor(document), ...mismatch },
				IP,
				HOSTNAME,
				false
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(receipts.findByAcceptanceId).not.toHaveBeenCalled();
		expect(receipts.createPending).not.toHaveBeenCalled();
		expect(tokens.issueConsent).not.toHaveBeenCalled();
	});

	it('reuses only the same pending evidence and never persists raw owner, IP or session identifiers', async () => {
		const { service, receipts, tokens } = setup();
		const document = service.publicDocument(widget, HOSTNAME);
		let stored: AiConsentReceipt | null = null;
		receipts.findByAcceptanceId.mockImplementation(() =>
			Promise.resolve(stored)
		);
		receipts.createPending.mockImplementation(
			(input: CreateAiConsentReceiptInput) => {
				stored = receiptFor(document, input);
				return Promise.resolve(stored);
			}
		);

		await expect(
			service.accept(PUBLIC_KEY, inputFor(document), IP, HOSTNAME, false)
		).resolves.toMatchObject({ acceptanceId: ACCEPTANCE_ID });
		await expect(
			service.accept(PUBLIC_KEY, inputFor(document), IP, HOSTNAME, false)
		).resolves.toMatchObject({ acceptanceId: ACCEPTANCE_ID });

		expect(receipts.createPending).toHaveBeenCalledTimes(1);
		const persisted = receipts.createPending.mock.calls[0][0];
		expect(Object.keys(persisted)).not.toEqual(
			expect.arrayContaining(['userId', 'ownerId', 'ip', 'sessionId'])
		);
		expect(JSON.stringify(persisted)).not.toContain(widget.userId);
		expect(JSON.stringify(persisted)).not.toContain(IP);
		expect(JSON.stringify(persisted)).not.toContain(SESSION_ID);
		expect(persisted).toMatchObject({
			ownerScope: scopes.ownerScope,
			sourceScope: scopes.sourceScope,
			sessionScope: scopes.sessionScope,
			acceptedAt: NOW,
			proofExpiresAt: PROOF_EXPIRES_AT
		});
		expect(tokens.issueConsent).toHaveBeenCalledTimes(2);
	});

	it('rejects acceptanceId reuse when any immutable evidence differs', async () => {
		const { service, receipts, tokens } = setup();
		const document = service.publicDocument(widget, HOSTNAME);
		receipts.findByAcceptanceId.mockResolvedValue(
			receiptFor(document, { sourceScope: 'x'.repeat(43) })
		);

		await expect(
			service.accept(PUBLIC_KEY, inputFor(document), IP, HOSTNAME, false)
		).rejects.toBeInstanceOf(ConflictException);
		expect(receipts.createPending).not.toHaveBeenCalled();
		expect(tokens.issueConsent).not.toHaveBeenCalled();
	});

	it('binds a direct preview with an empty install domain to the request hostname', async () => {
		const previewWidget = { ...widget, installDomain: '' };
		const { service, receipts } = setup(previewWidget);
		const document = service.publicDocument(previewWidget, HOSTNAME);
		receipts.findByAcceptanceId.mockResolvedValue(null);
		receipts.createPending.mockImplementation(
			(input: CreateAiConsentReceiptInput) =>
				Promise.resolve(receiptFor(document, input))
		);

		await expect(
			service.accept(PUBLIC_KEY, inputFor(document), IP, HOSTNAME, true)
		).resolves.toMatchObject({ acceptanceId: ACCEPTANCE_ID });
		expect(receipts.createPending).toHaveBeenCalledWith(
			expect.objectContaining({
				configuredSiteHostname: HOSTNAME,
				requestHostname: HOSTNAME
			})
		);
	});

	it('prepares a session only when the signed proof and every stored evidence field match', async () => {
		const { service, receipts, tokens } = setup();
		const document = service.publicDocument(widget, HOSTNAME);
		const claims = claimsFor(document);
		tokens.verifyConsent.mockReturnValue(claims);
		receipts.findById.mockResolvedValue(receiptFor(document));

		await expect(
			service.prepareSession(
				PUBLIC_KEY,
				SESSION_ID,
				'signed-consent-token',
				IP,
				HOSTNAME,
				false
			)
		).resolves.toEqual({
			widget,
			expectedHostname: HOSTNAME,
			claims
		});
		expect(tokens.verifyConsent).toHaveBeenCalledWith(
			'signed-consent-token',
			{ publicKey: PUBLIC_KEY, sessionId: SESSION_ID, ip: IP }
		);
		expect(tokens.assertWidget).toHaveBeenCalledWith(claims, widget);

		receipts.findById.mockResolvedValue(
			receiptFor(document, { documentHash: 'f'.repeat(64) })
		);
		await expect(
			service.prepareSession(
				PUBLIC_KEY,
				SESSION_ID,
				'signed-consent-token',
				IP,
				HOSTNAME,
				false
			)
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it('atomically verifies the exact prepared receipt and fails when the CAS loses', async () => {
		const { service, receipts } = setup();
		const document = service.publicDocument(widget, HOSTNAME);
		const prepared: WidgetsAiPreparedConsent = {
			widget,
			expectedHostname: HOSTNAME,
			claims: claimsFor(document)
		};
		receipts.verifyPending.mockResolvedValue(receiptFor(document));

		await expect(
			service.verifyPrepared(prepared)
		).resolves.toBeUndefined();
		expect(receipts.verifyPending).toHaveBeenCalledWith({
			id: RECEIPT_ID,
			acceptanceId: ACCEPTANCE_ID,
			now: NOW
		});

		receipts.verifyPending.mockResolvedValue(null);
		await expect(service.verifyPrepared(prepared)).rejects.toBeInstanceOf(
			UnauthorizedException
		);
	});

	it('requires a VERIFIED receipt lookup with the complete session evidence', async () => {
		const { service, receipts, tokens } = setup();
		const document = service.publicDocument(widget, HOSTNAME);
		const claims: WidgetsAiSessionClaims = {
			...claimsFor(document),
			expiresAt: new Date('2026-08-30T12:10:00.000Z').getTime()
		};
		receipts.findVerifiedByIdAndEvidence.mockResolvedValue(
			receiptFor(document, {
				status: AiConsentReceiptStatus.VERIFIED,
				verifiedAt: NOW
			})
		);

		await expect(
			service.assertVerified(widget, claims)
		).resolves.toBeUndefined();
		expect(tokens.assertWidget).toHaveBeenCalledWith(claims, widget);
		expect(receipts.findVerifiedByIdAndEvidence).toHaveBeenCalledWith<
			[VerifiedAiConsentLookup]
		>({
			id: RECEIPT_ID,
			acceptanceId: ACCEPTANCE_ID,
			widgetId: widget.id,
			widgetPublicKey: PUBLIC_KEY,
			ownerScope: scopes.ownerScope,
			configuredSiteHostname: HOSTNAME,
			requestHostname: HOSTNAME,
			publishedVersion: widget.publishedVersion,
			sessionScope: scopes.sessionScope,
			sourceScope: scopes.sourceScope,
			documentVersion: document.documentVersion,
			documentHash: document.documentHash,
			statementText: document.statementText,
			privacyUrl: document.privacyUrl
		});

		receipts.findVerifiedByIdAndEvidence.mockResolvedValue(null);
		await expect(
			service.assertVerified(widget, claims)
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it('enforces the IP rate limit before any repository lookup', async () => {
		const { service, widgets, receipts } = setup();
		const document = service.publicDocument(widget, HOSTNAME);
		receipts.findByAcceptanceId.mockResolvedValue(receiptFor(document));

		for (let attempt = 0; attempt < 60; attempt += 1) {
			await service.accept(
				PUBLIC_KEY,
				inputFor(document),
				IP,
				HOSTNAME,
				false
			);
		}
		expect(widgets.findByPublicKey).toHaveBeenCalledTimes(60);
		expect(receipts.findByAcceptanceId).toHaveBeenCalledTimes(60);

		await expect(
			service.accept(PUBLIC_KEY, inputFor(document), IP, HOSTNAME, false)
		).rejects.toBeInstanceOf(HttpException);
		expect(widgets.findByPublicKey).toHaveBeenCalledTimes(60);
		expect(receipts.findByAcceptanceId).toHaveBeenCalledTimes(60);
	});
});
