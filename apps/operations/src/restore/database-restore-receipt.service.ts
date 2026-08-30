import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class DatabaseRestoreReceiptService {
	sign(payload: string): {
		payloadSha256: string;
		signatureHmacSha256: string;
		signatureKeyId: string;
	} {
		const key = this.key();
		try {
			return {
				payloadSha256: this.sha256(payload),
				signatureHmacSha256: createHmac('sha256', key.value)
					.update(payload)
					.digest('hex'),
				signatureKeyId: key.id
			};
		} finally {
			key.value.fill(0);
		}
	}

	assertSignature(input: {
		payload: string;
		payloadSha256: string;
		signatureHmacSha256: string;
		signatureKeyId: string;
	}): void {
		const key = this.key();
		try {
			if (input.signatureKeyId !== key.id) {
				throw new Error(
					'Database restore receipt signing key ID is not active'
				);
			}
			const expectedPayloadSha = this.sha256(input.payload);
			const expectedSignature = createHmac('sha256', key.value)
				.update(input.payload)
				.digest('hex');
			if (
				!this.equalHex(expectedPayloadSha, input.payloadSha256) ||
				!this.equalHex(expectedSignature, input.signatureHmacSha256)
			) {
				throw new Error('Database restore receipt signature is invalid');
			}
		} finally {
			key.value.fill(0);
		}
	}

	canonicalize(value: unknown): string {
		if (value === null) return 'null';
		if (
			typeof value === 'string' ||
			typeof value === 'boolean' ||
			typeof value === 'number'
		) {
			if (typeof value === 'number' && !Number.isFinite(value)) {
				throw new Error('Receipt payload contains a non-finite number');
			}
			return JSON.stringify(value);
		}
		if (Array.isArray(value)) {
			return `[${value.map(item => this.canonicalize(item)).join(',')}]`;
		}
		if (typeof value === 'object') {
			const record = value as Record<string, unknown>;
			return `{${Object.keys(record)
				.sort()
				.map(
					key => `${JSON.stringify(key)}:${this.canonicalize(record[key])}`
				)
				.join(',')}}`;
		}
		throw new Error('Receipt payload contains an unsupported value');
	}

	sha256(value: string): string {
		return createHash('sha256').update(value).digest('hex');
	}

	private key(): { id: string; value: Buffer } {
		const encodedKey =
			process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64?.trim();
		const id = process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID?.trim();
		if (
			!encodedKey ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey) ||
			!id ||
			!/^[A-Za-z0-9._:-]{1,80}$/.test(id)
		) {
			throw new Error(
				'Database restore receipt signing is not configured'
			);
		}
		const value = Buffer.from(encodedKey, 'base64');
		if (
			value.length < 32 ||
			value.toString('base64').replace(/=+$/u, '') !==
				encodedKey.replace(/=+$/u, '')
		) {
			value.fill(0);
			throw new Error('Database restore receipt signing key is invalid');
		}
		return { id, value };
	}

	private equalHex(left: string, right: string): boolean {
		if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
			return false;
		}
		return timingSafeEqual(
			Buffer.from(left, 'hex'),
			Buffer.from(right, 'hex')
		);
	}
}
