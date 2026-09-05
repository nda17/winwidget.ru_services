import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	parseCommand,
	parseQuote,
	query,
	validVersion
} from './billing.validation';
import { parseBillingResponse } from './billing-response.parser';

const workspaceId = randomUUID(),
	commandId = randomUUID();
const command = {
	schemaVersion: 1,
	workspaceId,
	commandId,
	expectedBillingVersion: '0',
	expectedPolicyVersion: 1,
	cycle: 'MONTHLY',
	totalSeats: 2,
	autoRenew: false,
	consentVersion: null
};
const policy = {
	policyVersion: 1,
	monthlyPriceMinor: 10000,
	yearlyPriceMinor: 100000,
	additionalSeatMonthlyPriceMinor: 5000,
	additionalSeatYearlyPriceMinor: 50000,
	includedSeats: 2,
	graceDays: 3
};
const summary = {
	schemaVersion: 1,
	workspaceId,
	billingVersion: '0',
	serverTime: '2026-09-05T00:00:00.000Z',
	policy,
	trial: null,
	period: null,
	pendingOrder: null,
	renewal: {
		version: 0,
		state: 'NONE',
		canDisable: false,
		dispatchPending: false,
		nextChargeAt: null,
		nextRetryAt: null,
		retryAttempt: 0,
		methodLast4: null,
		methodTitle: null
	}
};
describe('CRM billing exact boundary contracts', () => {
	it('only adds the server-resolved actor to public checkout', () => {
		expect(
			parseCommand('WINCRM_CHECKOUT', command, commandId, 'owner')
		).toEqual({ ...command, actorSubject: 'owner' });
	});
	it.each([
		{ actorSubject: 'forged' },
		{ capacityFence: {} },
		{ price: 1 },
		{ totalSeats: 1 },
		{ totalSeats: 2.5 },
		{ cycle: ['MONTHLY'] },
		{ autoRenew: 'false' },
		{ consentVersion: 'unsolicited' },
		{ expectedBillingVersion: '01' },
		{ schemaVersion: 2 }
	])(
		'rejects altered checkout fields without echoing values: %j',
		patch => {
			expect(() =>
				parseCommand(
					'WINCRM_CHECKOUT',
					{ ...command, ...patch },
					commandId,
					'owner'
				)
			).toThrow('Invalid CRM billing request');
		}
	);
	it('requires exact command/header binding and explicit consent', () => {
		expect(() =>
			parseCommand('WINCRM_CHECKOUT', command, randomUUID(), 'owner')
		).toThrow(BadRequestException);
		expect(() =>
			parseCommand(
				'WINCRM_CHECKOUT',
				{ ...command, autoRenew: true },
				commandId,
				'owner'
			)
		).toThrow(BadRequestException);
		expect(
			parseCommand(
				'WINCRM_CHECKOUT',
				{
					...command,
					autoRenew: true,
					consentVersion: 'wincrm-auto-renewal-v1'
				},
				commandId,
				'owner'
			)
		).toMatchObject({ autoRenew: true });
	});
	it('accepts versioned renewal reconsent without any capacity override', () => {
		const renewal = {
			schemaVersion: 1,
			workspaceId,
			commandId,
			expectedBillingVersion: '9',
			expectedRenewalVersion: 2,
			expectedPolicyVersion: 3,
			consentVersion: 'wincrm-auto-renewal-v1'
		};
		expect(
			parseCommand('WINCRM_CONFIRM_RENEWAL', renewal, commandId, 'owner')
		).toEqual({ ...renewal, actorSubject: 'owner' });
	});
	it('supports read-only RENEWAL quote and rejects actor/price injection', () => {
		const quote = {
			schemaVersion: 1,
			workspaceId,
			intent: 'RENEWAL',
			cycle: 'YEARLY',
			totalSeats: 4
		};
		expect(parseQuote(quote)).toEqual(quote);
		expect(() => parseQuote({ ...quote, actorSubject: 'forged' })).toThrow(
			BadRequestException
		);
	});
	it('rejects object coercion and noncanonical identifiers before persistence', () => {
		const quote = {
			schemaVersion: 1,
			workspaceId,
			intent: { toString: null },
			cycle: 'MONTHLY',
			totalSeats: 2
		};
		expect(() => parseQuote(quote)).toThrow(BadRequestException);
		expect(() =>
			parseCommand(
				'WINCRM_CHECKOUT',
				{ ...command, commandId: commandId.toUpperCase() },
				commandId.toUpperCase(),
				'owner'
			)
		).toThrow(BadRequestException);
	});
	it('bounds canonical decimal versions and server pagination', () => {
		expect(validVersion('9223372036854775807')).toBe(true);
		expect(validVersion('9223372036854775808')).toBe(false);
		expect(
			query({ workspaceId, page: '2', pageSize: '100' }, 'history')
		).toEqual({ workspaceId, page: 2, pageSize: 100 });
		for (const value of ['0', '01', '101', ['20']])
			expect(() =>
				query({ workspaceId, pageSize: value }, 'history')
			).toThrow(BadRequestException);
	});
	it('validates the empty pre-activation summary without activating anything', () => {
		expect(parseBillingResponse('summary', summary, workspaceId)).toEqual(
			summary
		);
	});
	it.each([
		{ workspaceId: randomUUID() },
		{ secret: 'must-not-escape' },
		{ serverTime: '2026-09-05' },
		{ billingVersion: '01' },
		{ policy: { ...policy, monthlyPriceMinor: 0 } },
		{ policy: { ...policy, graceDays: 4 } },
		{ renewal: { ...summary.renewal, methodLast4: '12345' } }
	])('fails closed for invalid upstream summary %j', patch => {
		expect(() =>
			parseBillingResponse(
				'summary',
				{ ...summary, ...patch },
				workspaceId
			)
		).toThrow('BILLING_RESPONSE_CONTRACT');
	});
	it('correlates exact operation proof and terminal release flags', () => {
		const requestHash = 'a'.repeat(64),
			binding = { commandId, requestHash };
		const proof = {
			schemaVersion: 1,
			workspaceId,
			...binding,
			status: 'PENDING',
			billingVersion: '1',
			releaseFence: false,
			holdUntil: null,
			order: null,
			period: null
		};
		expect(
			parseBillingResponse('proof', proof, workspaceId, binding)
		).toEqual(proof);
		for (const patch of [
			{ commandId: randomUUID() },
			{ requestHash: 'b'.repeat(64) },
			{ releaseFence: true },
			{ status: 'CANCELLED' },
			{ holdUntil: '2026-09-06T00:00:00.000Z' }
		])
			expect(() =>
				parseBillingResponse(
					'proof',
					{ ...proof, ...patch },
					workspaceId,
					binding
				)
			).toThrow('BILLING_RESPONSE_CONTRACT');
	});
});
