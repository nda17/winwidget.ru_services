import {
	buildBillingOfferChangedEvent,
	isAutoRenewalOfferCompatible,
	nextBillingOfferCursor
} from './billing-offer-continuity';
import { sanitizeLegalHtml } from '../content/platform-content.validation';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	readPlatformSemanticFingerprint,
	refreshPlatformSemanticFingerprint
} from './platform-sequence';

const COMPATIBLE_OFFER = `
<section data-winwidget-section="auto-renewal-v1">
  <h2>Автоматическое продление подписки</h2>
  <p>Пользователь может выбрать разовую оплату либо подключить автоматическое продление подписки. Автоматическое продление подключается только после отдельного согласия Пользователя на странице оплаты.</p>
  <p>При подключении автоматического продления Пользователь поручает Исполнителю сохранить в ЮKassa выбранный способ оплаты и инициировать последующие безакцептные списания (без дополнительного подтверждения каждой операции) в размере и с периодичностью, указанными на странице оплаты: ежемесячно либо ежегодно. Первоначальный платёж подтверждается Пользователем в ЮKassa. Последующие платежи выполняются с использованием сохранённого способа оплаты при наступлении даты очередного продления.</p>
  <p>Пользователь вправе в любое время отключить автоматическое продление в личном кабинете либо направить отказ в электронной форме в службу поддержки по адресу <a href="mailto:info@winwidget.ru">info@winwidget.ru</a>, указав адрес электронной почты или номер телефона, привязанный к учётной записи. После получения и идентификации такого отказа Исполнитель прекращает использовать сохранённый способ оплаты для будущих списаний. Отключение не отменяет платёж, выполненный до получения отказа, и не прекращает текущий оплаченный период. Само по себе отключение не означает автоматического возврата денежных средств, однако настоящее положение не ограничивает права гражданина-потребителя на отказ от договора и возврат денежных средств в случаях и порядке, предусмотренных законодательством Российской Федерации, включая статью 32 Закона Российской Федерации от 07.02.1992 № 2300-1 «О защите прав потребителей».</p>
  <p>Если первая попытка очередного списания отклонена из-за недостатка денежных средств либо временной недоступности банка, Исполнитель вправе выполнить не более двух повторных попыток: ориентировочно через 24 часа и через 72 часа с момента первого отказа. Запрос на каждую повторную попытку может быть отправлен в течение не более одного часа после соответствующего расчётного момента; если в это окно он не отправлен, такая попытка автоматически не выполняется. Размер каждого повторного списания не превышает сумму, подтверждённую Пользователем для соответствующего периода продления. До отправки запроса на повторную попытку Пользователь может отключить автоматическое продление в личном кабинете или через службу поддержки.</p>
  <p>Новый период подписки начинается и доступ продлевается только после успешного завершения первоначальной либо одной из разрешённых повторных попыток списания; до этого новый период не считается оплаченным. При иных причинах отказа повторные списания автоматически не выполняются. Если ни одна из разрешённых повторных попыток не завершилась успешно, подписка на новый период не продлевается, а автоматическое продление приостанавливается. Исполнитель также вправе временно приостановить автоматическое продление при технической ошибке, отсутствии сохранённого способа оплаты, неподтверждённом контакте или несоответствии состояния подписки.</p>
  <p>При изменении стоимости тарифа новая цена не списывается автоматически. Автоматическое продление приостанавливается до отдельного подтверждения Пользователем прежней и новой стоимости в личном кабинете. Если Пользователь не подтвердит новую стоимость, подписка действует до окончания уже оплаченного периода и далее автоматически не продлевается.</p>
  <p>При каждом успешном расчёте Исполнитель обеспечивает направление электронного кассового чека на адрес электронной почты или абонентский номер, предоставленный Пользователем до совершения расчёта. Сведения о платежах и доступные ссылки на кассовые чеки размещаются в личном кабинете. Ссылка на чек на сайте оператора фискальных данных в личном кабинете является дополнительным способом доступа к уже сформированному чеку и не заменяет его направление Пользователю в установленном законом порядке. Факт согласия, выбранный тариф, периодичность, сумма, дата и технические данные подтверждения фиксируются Исполнителем.</p>
</section>`;

describe('Billing offer producer continuity contract', () => {
	it('starts the current v2 cursor at one in a fresh apps-only database', () => {
		expect(
			nextBillingOfferCursor({
				producerContractVersion: 2,
				sourceSequenceScope: 'billing.offer:offer',
				currentAggregateVersion: 0n,
				currentSourceSequence: 0n
			})
		).toEqual({ aggregateVersion: 1n, sourceSequence: 1n });
	});

	it('continues exactly one step after the current producer-scoped cursor', () => {
		const cursor = nextBillingOfferCursor({
			producerContractVersion: 2,
			sourceSequenceScope: 'billing.offer:offer',
			currentAggregateVersion: 41n,
			currentSourceSequence: 870n
		});
		const event = buildBillingOfferChangedEvent({
			content: COMPATIBLE_OFFER,
			updatedAt: new Date('2026-08-23T12:00:00.000Z'),
			cursor,
			eventId: '11111111-1111-4111-8111-111111111111'
		});
		expect(event.aggregateVersion).toBe('42');
		expect(event.sourceSequence).toBe('871');
		expect(event).toMatchObject({
			schemaVersion: 2,
			eventType: 'billing.offer.changed.v2',
			sourceSequenceContractVersion: 2,
			sourceSequenceScope: 'billing.offer:offer'
		});
		expect(event.state.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects a negative runtime cursor', () => {
		expect(() =>
			nextBillingOfferCursor({
				producerContractVersion: 2,
				sourceSequenceScope: 'billing.offer:offer',
				currentAggregateVersion: -1n,
				currentSourceSequence: 1n
			})
		).toThrow('BILLING_OFFER_SCOPED_CURSOR_INVALID');
	});

	it('rejects the retired v1 allocator and an unscoped cursor', () => {
		expect(() =>
			nextBillingOfferCursor({
				producerContractVersion: 1,
				sourceSequenceScope: 'billing',
				currentAggregateVersion: 41n,
				currentSourceSequence: 870n
			})
		).toThrow('BILLING_OFFER_SCOPED_CURSOR_INVALID');
	});

	it('keeps the protected offer section byte-compatible after sanitizing', () => {
		expect(
			isAutoRenewalOfferCompatible(sanitizeLegalHtml(COMPATIBLE_OFFER))
		).toBe(true);
	});

	it('removes cutover ceremony while preserving current producer continuity', () => {
		const sql = readFileSync(
			join(
				__dirname,
				'../../prisma/migrations/20260827020000_remove_legacy_cutover_state/migration.sql'
			),
			'utf8'
		);
		expect(sql).toContain('DROP TYPE "platform"."ServiceDatabasePhase";');
		expect(sql).toContain('DROP TYPE "platform"."OfferProducerPhase";');
		expect(sql).toContain('DROP COLUMN "ownership_generation"');
		expect(sql).toContain('DROP COLUMN "source_snapshot_sha256"');
		expect(sql).toContain('DROP COLUMN "imported_aggregate_version"');
		expect(sql).toContain('DROP COLUMN "source_fence_fingerprint"');
		expect(sql).toContain(
			'COALESCE(\n        producer."current_source_sequence"'
		);
		expect(sql).toContain(
			'Platform Billing offer cursors must advance once in lockstep'
		);
		expect(sql).toContain(
			'CREATE FUNCTION "platform"."current_semantic_fingerprint"()'
		);
		expect(sql).toContain(
			'CREATE FUNCTION "platform"."refresh_current_semantic_fingerprint"('
		);
		const semanticFingerprintFunction = sql.match(
			/CREATE FUNCTION "platform"\."current_semantic_fingerprint"\(\)[\s\S]*?REVOKE ALL ON FUNCTION "platform"\."current_semantic_fingerprint"\(\) FROM PUBLIC;/
		)?.[0];
		expect(semanticFingerprintFunction).toContain(
			'"platform"."source_sequences"'
		);
		expect(semanticFingerprintFunction).toContain(
			'"platform"."site_settings"'
		);
		expect(semanticFingerprintFunction).toContain(
			'"platform"."legal_pages"'
		);
		expect(semanticFingerprintFunction).toContain(
			'"platform"."home_page_content"'
		);
		expect(semanticFingerprintFunction).toContain(
			'"platform"."billing_offer_producer_state"'
		);
		expect(semanticFingerprintFunction).toContain("'schemaVersion', 2");
		expect(semanticFingerprintFunction).not.toContain(
			'"source_fence_fingerprint"'
		);
		expect(sql).toContain('SECURITY INVOKER');
		expect(sql).not.toContain('SECURITY DEFINER');
		expect(sql).toContain('CREATE CONSTRAINT TRIGGER');
	});
});

describe('Platform current semantic fingerprint contract', () => {
	it('reads one exact database-computed SHA-256 fingerprint', async () => {
		const fingerprint = 'd'.repeat(64);
		const client = {
			$queryRaw: jest.fn().mockResolvedValue([{ fingerprint }])
		};

		await expect(
			readPlatformSemanticFingerprint(client as never)
		).resolves.toBe(fingerprint);
		expect(client.$queryRaw).toHaveBeenCalledTimes(1);
	});

	it('fails closed on a missing or malformed database fingerprint', async () => {
		const missing = { $queryRaw: jest.fn().mockResolvedValue([]) };
		const malformed = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ fingerprint: 'not-a-sha256' }])
		};

		await expect(
			readPlatformSemanticFingerprint(missing as never)
		).rejects.toThrow('PLATFORM_SEMANTIC_FINGERPRINT_READ_FAILED');
		await expect(
			refreshPlatformSemanticFingerprint(malformed as never)
		).rejects.toThrow('PLATFORM_SEMANTIC_FINGERPRINT_REFRESH_FAILED');
	});
});
