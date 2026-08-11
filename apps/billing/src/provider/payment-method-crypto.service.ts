import { Injectable } from '@nestjs/common';
import {
	createCipheriv,
	createDecipheriv,
	randomBytes
} from 'node:crypto';

@Injectable()
export class PaymentMethodCryptoService {
	private key(): Buffer {
		const encoded =
			process.env.PAYMENT_METHOD_ENCRYPTION_KEY?.trim() || '';
		let key: Buffer;
		try {
			key = Buffer.from(encoded, 'base64');
		} catch {
			key = Buffer.alloc(0);
		}
		if (key.length !== 32) {
			throw new Error(
				'PAYMENT_METHOD_ENCRYPTION_KEY must be a base64-encoded 32-byte key'
			);
		}
		return key;
	}

	encrypt(value: string): string {
		if (!value) throw new Error('Payment method ID must not be empty');
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
		const encrypted = Buffer.concat([
			cipher.update(value, 'utf8'),
			cipher.final()
		]);
		const tag = cipher.getAuthTag();
		return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
	}

	decrypt(value: string): string {
		const [version, ivValue, tagValue, ciphertextValue, ...rest] =
			value.split(':');
		if (
			version !== 'v1' ||
			!ivValue ||
			!tagValue ||
			!ciphertextValue ||
			rest.length
		) {
			throw new Error('Unsupported payment method ciphertext format');
		}
		const iv = Buffer.from(ivValue, 'base64');
		const tag = Buffer.from(tagValue, 'base64');
		const ciphertext = Buffer.from(ciphertextValue, 'base64');
		if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
			throw new Error('Invalid payment method ciphertext');
		}
		const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([
			decipher.update(ciphertext),
			decipher.final()
		]).toString('utf8');
	}
}
