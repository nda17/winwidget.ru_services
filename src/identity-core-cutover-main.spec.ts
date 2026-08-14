import {
	assertIdentityCoreDestinationFailuresDrained,
	assertIdentityCoreOutboxDrained,
	parseIdentityCoreCutoverArgs
} from './identity-core-cutover-main';

describe('Identity Core cutover CLI', () => {
	it('accepts only the explicit read-only preflight', () => {
		expect(parseIdentityCoreCutoverArgs(['preflight'])).toEqual({
			action: 'preflight'
		});
		expect(() =>
			parseIdentityCoreCutoverArgs(['preflight', '--file', '/tmp/value'])
		).toThrow('does not accept arguments');
	});

	it('accepts explicit status and reversible pre-boundary fence actions without arguments', () => {
		for (const action of ['status', 'fence', 'unfence'] as const) {
			expect(parseIdentityCoreCutoverArgs([action])).toEqual({ action });
			expect(() =>
				parseIdentityCoreCutoverArgs([action, '--force'])
			).toThrow('does not accept arguments');
		}
	});

	it('requires an absolute export target and rejects extra arguments', () => {
		expect(
			parseIdentityCoreCutoverArgs([
				'export',
				'--file',
				'/run/identity-cutover/snapshot.json'
			])
		).toEqual({
			action: 'export',
			file: '/run/identity-cutover/snapshot.json'
		});
		expect(() =>
			parseIdentityCoreCutoverArgs(['export', '--file', 'relative.json'])
		).toThrow('must be absolute');
		expect(() =>
			parseIdentityCoreCutoverArgs([
				'export',
				'--file',
				'/tmp/value',
				'--force',
				'true'
			])
		).toThrow('requires exactly');
	});

	it('fails the immutable export gate while a legacy identity event is unpublished', () => {
		expect(() => assertIdentityCoreOutboxDrained(1)).toThrow(
			'every legacy identity Outbox event to be PUBLISHED'
		);
		expect(() => assertIdentityCoreOutboxDrained(Number.NaN)).toThrow(
			'every legacy identity Outbox event to be PUBLISHED'
		);
		expect(() => assertIdentityCoreOutboxDrained(0)).not.toThrow();
	});

	it('fails the ownership boundary while a legacy destination failure is unresolved', () => {
		expect(() => assertIdentityCoreDestinationFailuresDrained(1)).toThrow(
			'every legacy Telegram destination failure to be resolved'
		);
		expect(() =>
			assertIdentityCoreDestinationFailuresDrained(Number.NaN)
		).toThrow('every legacy Telegram destination failure to be resolved');
		expect(() =>
			assertIdentityCoreDestinationFailuresDrained(0)
		).not.toThrow();
	});
});
