import { randomUUID } from 'node:crypto';
import {
	WidgetControlConfig,
	widgetControlEnabled,
	widgetOrigin
} from './widget-control.config';
import {
	parseCandidates,
	parseConfigureResponse,
	WidgetsControlClient,
	WidgetsControlDependencyError
} from './widgets-control.client';
import { parseControlEvent } from './widget-control.contract';
import { intakeProcessRole } from '../acceptance/acceptance.messaging';
import { parseCrmIntakePort } from '../runtime/crm-intake-runtime.config';
const workspaceId = randomUUID(),
	sourceId = randomUUID(),
	connectorId = randomUUID();
const request = {
	schemaVersion: 1 as const,
	commandId: randomUUID(),
	workspaceId,
	sourceId,
	ownerSubject: 'owner',
	widgetType: 'QUIZ' as const,
	widgetId: 'opaque-widget',
	controlVersion: 1,
	generation: 1,
	enabled: true
};
const acknowledged = () => ({
	schemaVersion: 1,
	connector: {
		id: connectorId,
		workspaceId,
		sourceId,
		ownerSubject: 'owner',
		widgetType: 'QUIZ',
		widgetId: 'opaque-widget',
		controlVersion: 1,
		generation: 1,
		enabled: true,
		enabledAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	}
});
const candidates = () => ({
	schemaVersion: 1,
	ownerSubject: 'owner',
	page: 1,
	pageSize: 25,
	total: 1,
	eligibility: {
		schemaVersion: 1,
		ownerSubject: 'owner',
		eligible: false,
		reason: 'NO_SUBSCRIPTION',
		subscriptionId: null,
		version: null,
		plan: null,
		startsAt: null,
		expiresAt: null,
		checkedAt: new Date().toISOString(),
		validUntil: new Date().toISOString()
	},
	items: [
		{
			widgetType: 'QUIZ',
			widgetId: 'opaque-widget',
			name: 'Опрос',
			isActive: true,
			publishedVersion: 1,
			createdAt: new Date().toISOString(),
			connector: null
		}
	]
});
describe('Widget control contracts and dependency boundary', () => {
	const env = process.env,
		fetchOriginal = global.fetch;
	beforeEach(() => {
		process.env = {
			...env,
			CRM_INTAKE_WIDGETS_ENABLED: 'true',
			WIDGETS_INTERNAL_BASE_URL: 'https://widgets.example.test',
			WIDGETS_CRM_INTAKE_TOKEN: 'a'.repeat(40)
		};
	});
	afterEach(() => {
		process.env = env;
		global.fetch = fetchOriginal;
	});
	test('default off ignores absent new credentials and origins', () => {
		delete process.env.CRM_INTAKE_WIDGETS_ENABLED;
		delete process.env.WIDGETS_INTERNAL_BASE_URL;
		delete process.env.WIDGETS_CRM_INTAKE_TOKEN;
		expect(widgetControlEnabled()).toBe(false);
		expect(new WidgetControlConfig().enabled).toBe(false);
	});
	test.each([
		'http://remote.example',
		'https://host/path',
		'https://user:pass@host',
		'https://host/?query',
		'https://host/#x'
	])('rejects non-exact/untrusted origin %s', value =>
		expect(() => widgetOrigin(value)).toThrow()
	);
	test('flag/credentials/process roles are fail closed', () => {
		process.env.CRM_INTAKE_WIDGETS_ENABLED = 'yes';
		expect(() => widgetControlEnabled()).toThrow();
		process.env.CRM_INTAKE_WIDGETS_ENABLED = 'true';
		process.env.WIDGETS_CRM_INTAKE_TOKEN = 'change_me';
		expect(() => new WidgetControlConfig()).toThrow();
		process.env.CRM_INTAKE_PROCESS_ROLE = 'widget-control-worker';
		expect(intakeProcessRole()).toBe('widget-control-worker');
		expect(parseCrmIntakePort(undefined, 'widget-control-worker')).toBe(
			5313
		);
		expect(parseCrmIntakePort(undefined, 'widget-control-publisher')).toBe(
			5314
		);
		process.env.CRM_INTAKE_WIDGETS_ENABLED = 'false';
		expect(() => intakeProcessRole()).toThrow();
	});
	test('ineligible subscription preserves actual owned candidates', () => {
		const response = candidates();
		response.eligibility.validUntil = response.eligibility.checkedAt;
		expect(parseCandidates(response, 'owner', 1, 25).items).toHaveLength(
			1
		);
		expect(
			parseCandidates(response, 'owner', 1, 25).eligibility.eligible
		).toBe(false);
	});
	test.each(['ownerSubject', 'page', 'schemaVersion'])(
		'rejects changed candidate binding %s',
		key => {
			const response = { ...candidates(), [key]: 'other' };
			expect(() => parseCandidates(response, 'owner', 1, 25)).toThrow();
		}
	);
	test('rejects duplicate widgets, extra fields and stale Billing proof', () => {
		const response = candidates();
		response.eligibility.validUntil = response.eligibility.checkedAt;
		expect(() =>
			parseCandidates(
				{ ...response, items: [...response.items, ...response.items] },
				'owner',
				1,
				25
			)
		).toThrow();
		expect(() =>
			parseCandidates({ ...response, secret: 'hidden' }, 'owner', 1, 25)
		).toThrow();
		response.eligibility.checkedAt = new Date(
			Date.now() - 10000
		).toISOString();
		expect(() => parseCandidates(response, 'owner', 1, 25)).toThrow();
	});
	test('acknowledgment proves exact immutable issued command, not latest state', () => {
		expect(
			parseConfigureResponse(acknowledged(), connectorId, request)
		).toHaveProperty('schemaVersion', 1);
		for (const change of [
			{ id: randomUUID() },
			{ workspaceId: randomUUID() },
			{ ownerSubject: 'foreign' },
			{ controlVersion: 2 },
			{ generation: 2 },
			{ enabled: false }
		]) {
			const response = acknowledged();
			expect(() =>
				parseConfigureResponse(
					{ ...response, connector: { ...response.connector, ...change } },
					connectorId,
					request
				)
			).toThrow();
		}
	});
	test('source RPC uses scoped pair, bounded JSON, no JWT and exact idempotency key', async () => {
		global.fetch = jest.fn().mockResolvedValue(
			new Response(JSON.stringify(acknowledged()), {
				headers: { 'content-type': 'application/json' }
			})
		);
		await new WidgetsControlClient(new WidgetControlConfig()).configure(
			connectorId,
			request
		);
		expect(global.fetch).toHaveBeenCalledWith(
			'https://widgets.example.test/internal/v1/crm-intake/widget-connectors/' +
				connectorId +
				'/configure',
			expect.objectContaining({
				redirect: 'error',
				cache: 'no-store',
				body: JSON.stringify(request),
				headers: expect.objectContaining({
					'idempotency-key': request.commandId,
					'x-winwidget-service': 'crm-intake'
				})
			})
		);
		expect(
			(global.fetch as jest.Mock).mock.calls[0][1].headers.authorization
		).toBeUndefined();
	});
	test('oversized/invalid responses and failures do not expose dependency values', async () => {
		global.fetch = jest.fn().mockResolvedValue(
			new Response('x'.repeat(17000), {
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(
			new WidgetsControlClient(new WidgetControlConfig()).configure(
				connectorId,
				request
			)
		).rejects.toMatchObject({ status: 503 });
		global.fetch = jest.fn().mockResolvedValue(
			new Response(JSON.stringify({ code: 'private-secret-value' }), {
				status: 403,
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(
			new WidgetsControlClient(new WidgetControlConfig()).configure(
				connectorId,
				request
			)
		).rejects.toEqual(
			new WidgetsControlDependencyError(403, 'DEPENDENCY_UNAVAILABLE')
		);
	});
	test('broker envelope is identifiers-only and exact', () => {
		const event = {
			schemaVersion: 1,
			eventId: randomUUID(),
			workspaceId,
			sourceId,
			commandId: request.commandId,
			controlVersion: 1,
			generation: 1
		};
		expect(parseControlEvent(event)).toEqual(event);
		expect(() =>
			parseControlEvent({ ...event, phone: '+79000000001' })
		).toThrow();
		expect(() =>
			parseControlEvent({ ...event, commandId: 'wrong' })
		).toThrow();
		expect(() => parseControlEvent({ ...event, generation: 2 })).toThrow();
	});
});
