import { YookassaService } from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

const FIRST_OFD_RECEIPT_HOST = 'consumer.1-ofd.ru';
const FIRST_OFD_RECEIPT_PATH = '/ticket';
const FISCAL_STORAGE_NUMBER_PATTERN = /^\d{16}$/;
const FISCAL_NUMBER_PATTERN = /^\d{1,12}$/;

@Injectable()
export class PaymentReceiptService {
	private readonly logger = new Logger(PaymentReceiptService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly yookassa: YookassaService
	) {}

	async syncForPayment(paymentId: string): Promise<number> {
		const payment = await this.prisma.payment.findUnique({
			where: { id: paymentId },
			select: {
				id: true,
				yookassaId: true,
				receiptSyncEligible: true
			}
		});
		if (!payment?.receiptSyncEligible || !payment.yookassaId) {
			return 0;
		}

		const receipts = await this.yookassa.getReceipts(payment.yookassaId);
		for (const receipt of receipts) {
			if (
				receipt.payment_id &&
				receipt.payment_id !== payment.yookassaId
			) {
				continue;
			}

			const publicUrl = this.buildFirstOfdReceiptUrl({
				fiscalStorageNumber: receipt.fiscal_storage_number,
				fiscalDocumentNumber: receipt.fiscal_document_number,
				fiscalAttribute: receipt.fiscal_attribute,
				receiptType: receipt.type,
				receiptStatus: receipt.status
			});
			await this.prisma.paymentReceipt.upsert({
				where: { providerReceiptId: receipt.id },
				update: {
					status: receipt.status,
					type: receipt.type ?? null,
					fiscalDocumentNumber: receipt.fiscal_document_number ?? null,
					fiscalStorageNumber: receipt.fiscal_storage_number ?? null,
					fiscalAttribute: receipt.fiscal_attribute ?? null,
					registeredAt: this.parseProviderDate(receipt.registered_at),
					publicUrl
				},
				create: {
					paymentId: payment.id,
					providerReceiptId: receipt.id,
					status: receipt.status,
					type: receipt.type ?? null,
					fiscalDocumentNumber: receipt.fiscal_document_number ?? null,
					fiscalStorageNumber: receipt.fiscal_storage_number ?? null,
					fiscalAttribute: receipt.fiscal_attribute ?? null,
					registeredAt: this.parseProviderDate(receipt.registered_at),
					publicUrl
				}
			});
		}
		return receipts.length;
	}

	async syncForProviderPayment(yookassaId: string): Promise<number> {
		const payment = await this.prisma.payment.findUnique({
			where: { yookassaId },
			select: { id: true, receiptSyncEligible: true }
		});
		if (!payment?.receiptSyncEligible) return 0;
		return this.syncForPayment(payment.id);
	}

	async syncMissingForHistory(
		payments: Array<{
			id: string;
			yookassaId: string | null;
			status: PaymentStatus;
			receiptSyncEligible: boolean;
			receipts: unknown[];
		}>
	): Promise<void> {
		const candidates = payments
			.filter(
				payment =>
					payment.receiptSyncEligible &&
					payment.status === PaymentStatus.SUCCEEDED &&
					Boolean(payment.yookassaId) &&
					payment.receipts.length === 0
			)
			.slice(0, 10);
		const results = await Promise.allSettled(
			candidates.map(payment => this.syncForPayment(payment.id))
		);
		results.forEach((result, index) => {
			if (result.status === 'rejected') {
				this.logger.warn(
					`Receipt sync failed for payment ${candidates[index].id}: ${
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason)
					}`
				);
			}
		});
	}

	buildFirstOfdReceiptUrl(input: {
		fiscalStorageNumber?: string | null;
		fiscalDocumentNumber?: string | null;
		fiscalAttribute?: string | null;
		receiptType?: string | null;
		receiptStatus?: string | null;
	}): string | null {
		const fn = input.fiscalStorageNumber?.trim() ?? '';
		const documentNumber = input.fiscalDocumentNumber?.trim() ?? '';
		const fiscalAttribute = input.fiscalAttribute?.trim() ?? '';
		if (
			input.receiptType !== 'payment' ||
			input.receiptStatus !== 'succeeded' ||
			!FISCAL_STORAGE_NUMBER_PATTERN.test(fn) ||
			!FISCAL_NUMBER_PATTERN.test(documentNumber) ||
			!FISCAL_NUMBER_PATTERN.test(fiscalAttribute)
		) {
			return null;
		}

		const url = new URL(
			`https://${FIRST_OFD_RECEIPT_HOST}${FIRST_OFD_RECEIPT_PATH}`
		);
		url.searchParams.set('fn', fn);
		url.searchParams.set('i', documentNumber);
		url.searchParams.set('fp', fiscalAttribute);
		url.searchParams.set('n', '1');
		return url.toString();
	}

	private parseProviderDate(value?: string): Date | null {
		if (!value) return null;
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
}
