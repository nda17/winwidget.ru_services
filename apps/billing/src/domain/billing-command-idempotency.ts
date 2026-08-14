import { Prisma } from '@prisma/billing-client';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

type BillingCommandReceipt = {
	commandType: string;
	requestHash: string;
	requestHashVersion: number;
	result: Prisma.JsonValue;
};

export function billingCommandRequestHash(
	commandType: string,
	payload: Record<string, unknown>
): string {
	return createHash('sha256')
		.update(canonicalJson({ commandType, payload }))
		.digest('hex');
}

export function assertBillingCommandReceipt(
	receipt: BillingCommandReceipt,
	commandType: string,
	requestHash: string
): Prisma.JsonValue {
	if (receipt.commandType !== commandType) {
		throw new ConflictException(
			'Command ID was used for another command type'
		);
	}
	if (receipt.requestHashVersion !== 1) {
		throw new ConflictException(
			'Command receipt predates request binding and cannot be safely retried'
		);
	}
	if (receipt.requestHash !== requestHash) {
		throw new ConflictException(
			'Command ID was used with a different request'
		);
	}
	return receipt.result;
}

export function lockBillingCommand(
	transaction: Prisma.TransactionClient,
	commandId: string
): Promise<number> {
	return transaction.$executeRaw(Prisma.sql`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`billing-command:${commandId}`}, 0)
		)
	`);
}

function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string' || typeof value === 'boolean') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError(
				'Billing command payload contains a non-finite number'
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.filter(key => record[key] !== undefined)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${entries.join(',')}}`;
	}
	throw new TypeError('Billing command payload is not JSON-compatible');
}
