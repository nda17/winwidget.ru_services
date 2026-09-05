import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import {
	GUARDS_METADATA,
	METHOD_METADATA,
	PATH_METADATA,
	PIPES_METADATA
} from '@nestjs/common/constants';
import { BillingWincrmCommerceController } from './billing-wincrm-commerce.controller';
import {
	BillingWincrmProviderController,
	RetryWincrmProviderDto
} from './billing-wincrm-provider.controller';
import {
	WincrmCheckoutDto,
	WincrmHistoryDto,
	WincrmVerifyOrderDto
} from './billing-wincrm-commerce.dto';
import { BillingCrmAccessGuard } from '../auth/billing-crm-access.guard';
import {
	BILLING_REQUIRED_ROLES,
	BillingAuthGuard
} from '../auth/billing-auth.guard';

const W = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const checkout = {
	schemaVersion: 1,
	workspaceId: W,
	actorSubject: 'owner',
	commandId: C,
	expectedBillingVersion: '0',
	expectedPolicyVersion: 2,
	cycle: 'MONTHLY',
	totalSeats: 2,
	autoRenew: false,
	consentVersion: null,
	capacityFence: {
		operationId: C,
		requestHash: 'a'.repeat(64),
		fenceRevision: 1,
		targetSeats: 2
	}
};

describe('WinCRM commerce isolated HTTP contracts', () => {
	it('excludes every real commerce POST from the production bootstrap public prefix, without wildcards', () => {
		const source = ts.createSourceFile(
			'main.ts',
			readFileSync(join(__dirname, '../main.ts'), 'utf8'),
			ts.ScriptTarget.Latest,
			true
		);
		const exclusions: { path: string; method: string }[] = [];
		const inspect = (node: ts.Node) => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === 'setGlobalPrefix'
			) {
				expect(node.arguments[0].getText(source)).toBe("'api/v1'");
				const options = node.arguments[1];
				if (!ts.isObjectLiteralExpression(options))
					throw new Error('Unexpected bootstrap prefix options');
				const exclude = options.properties.find(
					(property): property is ts.PropertyAssignment =>
						ts.isPropertyAssignment(property) &&
						property.name.getText(source) === 'exclude'
				);
				if (!exclude || !ts.isArrayLiteralExpression(exclude.initializer))
					throw new Error('Unexpected bootstrap exclusions');
				for (const item of exclude.initializer.elements) {
					if (!ts.isObjectLiteralExpression(item))
						throw new Error('Unexpected non-exact route exclusion');
					const properties = new Map(
						item.properties
							.filter(ts.isPropertyAssignment)
							.map(property => [
								property.name.getText(source),
								property.initializer
							])
					);
					const path = properties.get('path');
					if (!path || !ts.isStringLiteral(path))
						throw new Error('Unexpected non-literal route exclusion');
					exclusions.push({
						path: path.text,
						method: properties.get('method')?.getText(source) ?? ''
					});
				}
			}
			ts.forEachChild(node, inspect);
		};
		inspect(source);
		const prefix = Reflect.getMetadata(
			PATH_METADATA,
			BillingWincrmCommerceController
		) as string;
		const expected = Object.getOwnPropertyNames(
			BillingWincrmCommerceController.prototype
		)
			.flatMap(name => {
				const method = (
					BillingWincrmCommerceController.prototype as unknown as Record<
						string,
						unknown
					>
				)[name];
				if (
					typeof method !== 'function' ||
					Reflect.getMetadata(METHOD_METADATA, method) !==
						RequestMethod.POST
				)
					return [];
				return [
					{
						path: `${prefix}/${Reflect.getMetadata(PATH_METADATA, method) as string}`,
						method: 'RequestMethod.POST'
					}
				];
			})
			.sort((left, right) => left.path.localeCompare(right.path));
		expect(expected).toHaveLength(11);
		expect(
			exclusions
				.filter(item => item.path.startsWith(prefix))
				.sort((left, right) => left.path.localeCompare(right.path))
		).toEqual(expected);
		expect(exclusions.every(item => !/[()*]/.test(item.path))).toBe(true);
	});
	const pipe = (
		Reflect.getMetadata(
			PIPES_METADATA,
			BillingWincrmCommerceController
		) as ValidationPipe[]
	)[0];
	it('requires the existing scoped Access pair on every commerce endpoint', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, BillingWincrmCommerceController)
		).toBe('internal/v1/crm-access/billing/commerce');
		expect(
			Reflect.getMetadata(GUARDS_METADATA, BillingWincrmCommerceController)
		).toEqual([BillingCrmAccessGuard]);
	});
	it.each([
		{ schemaVersion: 2 },
		{ workspaceId: 'other' },
		{ actorSubject: 'bad actor' },
		{ cycle: ['MONTHLY'] },
		{ totalSeats: 1 },
		{ totalSeats: 2.5 },
		{ totalSeats: 10001 },
		{ expectedBillingVersion: 0 },
		{ autoRenew: 'true' },
		{ currency: 'USD' },
		{ capacityFence: { ...checkout.capacityFence, targetSeats: 1 } },
		{ capacityFence: { ...checkout.capacityFence, forbidden: true } }
	])('rejects malformed or extra checkout fields %#', async patch => {
		await expect(
			pipe.transform(
				{ ...checkout, ...patch },
				{ type: 'body', metatype: WincrmCheckoutDto }
			)
		).rejects.toBeDefined();
	});
	it('does not silently coerce the internal monetary command', async () =>
		expect(
			await pipe.transform(checkout, {
				type: 'body',
				metatype: WincrmCheckoutDto
			})
		).toEqual(checkout));
	it('rejects mismatch before business work', () => {
		const service = { checkout: jest.fn() };
		const controller = new BillingWincrmCommerceController(
			service as never
		);
		expect(() =>
			controller.checkout(checkout as never, 'different')
		).toThrow('Idempotency-Key');
		expect(service.checkout).not.toHaveBeenCalled();
	});
	it.each([
		{ page: 0, pageSize: 10 },
		{ page: 1, pageSize: 101 },
		{ page: '1', pageSize: 10 },
		{ page: 1000001, pageSize: 10 }
	])('bounds history server pagination %#', async page =>
		expect(
			pipe.transform(
				{
					schemaVersion: 1,
					workspaceId: W,
					actorSubject: 'owner',
					...page
				},
				{ type: 'body', metatype: WincrmHistoryDto }
			)
		).rejects.toBeDefined()
	);
	it('verification has no caller-supplied provider ID or POST mode', async () =>
		expect(
			pipe.transform(
				{
					schemaVersion: 1,
					workspaceId: W,
					actorSubject: 'owner',
					commandId: C,
					expectedBillingVersion: '1',
					orderId: W,
					expectedOrderVersion: 1,
					providerPaymentId: 'forged'
				},
				{ type: 'body', metatype: WincrmVerifyOrderDto }
			)
		).rejects.toBeDefined());
	it('independent provider retry is DEV-only, not workspace-owner or ADMIN', () => {
		const retry = BillingWincrmProviderController.prototype.retry;
		expect(Reflect.getMetadata(BILLING_REQUIRED_ROLES, retry)).toEqual([
			'DEV'
		]);
		expect(Reflect.getMetadata(GUARDS_METADATA, retry)).toEqual([
			BillingAuthGuard
		]);
	});
	it.each([
		{ expectedVersion: 0 },
		{ commandId: 'bad' },
		{ providerPaymentId: 'forged' },
		{ mode: 'CREATE' },
		{ actorId: 'dev' }
	])('provider retry excludes unsafe extra input %#', async patch => {
		const retryPipe = (
			Reflect.getMetadata(
				PIPES_METADATA,
				BillingWincrmProviderController.prototype.retry
			) as ValidationPipe[]
		)[0];
		await expect(
			retryPipe.transform(
				{ schemaVersion: 1, commandId: C, expectedVersion: 1, ...patch },
				{ type: 'body', metatype: RetryWincrmProviderDto }
			)
		).rejects.toBeDefined();
	});
});
