import { BadRequestException, Injectable } from '@nestjs/common';
import {
	createCipheriv,
	createDecipheriv,
	randomBytes
} from 'node:crypto';

const ENCRYPTION_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class PaymentMethodCryptoService {
	assertConfigured(): void {
		this.getKey();
	}

	encrypt(paymentMethodId: string): string {
		const normalized = paymentMethodId.trim();
		if (!normalized) {
			throw new BadRequestException(
				'ЮKassa не вернула сохранённый способ оплаты'
			);
		}

		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, this.getKey(), iv, {
			authTagLength: AUTH_TAG_LENGTH
		});
		const ciphertext = Buffer.concat([
			cipher.update(normalized, 'utf8'),
			cipher.final()
		]);
		const authTag = cipher.getAuthTag();

		return [
			ENCRYPTION_VERSION,
			iv.toString('base64url'),
			authTag.toString('base64url'),
			ciphertext.toString('base64url')
		].join(':');
	}

	decrypt(value: string): string {
		const [version, ivValue, authTagValue, ciphertextValue, extra] =
			value.split(':');
		if (
			version !== ENCRYPTION_VERSION ||
			!ivValue ||
			!authTagValue ||
			!ciphertextValue ||
			extra
		) {
			throw new Error('Unsupported encrypted payment method format');
		}

		const iv = Buffer.from(ivValue, 'base64url');
		const authTag = Buffer.from(authTagValue, 'base64url');
		const ciphertext = Buffer.from(ciphertextValue, 'base64url');
		if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
			throw new Error('Invalid encrypted payment method payload');
		}

		const decipher = createDecipheriv(ALGORITHM, this.getKey(), iv, {
			authTagLength: AUTH_TAG_LENGTH
		});
		decipher.setAuthTag(authTag);
		return Buffer.concat([
			decipher.update(ciphertext),
			decipher.final()
		]).toString('utf8');
	}

	private getKey(): Buffer {
		const encoded = process.env.PAYMENT_METHOD_ENCRYPTION_KEY?.trim();
		if (!encoded) {
			throw new BadRequestException(
				'Автопродление временно недоступно: не настроено шифрование платёжного метода'
			);
		}

		const key = Buffer.from(encoded, 'base64');
		const normalizedInput = encoded.replace(/=+$/, '');
		const normalizedEncodedKey = key.toString('base64').replace(/=+$/, '');
		if (
			!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
			normalizedInput !== normalizedEncodedKey
		) {
			throw new BadRequestException(
				'Автопродление временно недоступно: некорректный ключ шифрования'
			);
		}

		if (key.length !== 32) {
			throw new BadRequestException(
				'Автопродление временно недоступно: ключ шифрования должен содержать 32 байта'
			);
		}

		return key;
	}
}
