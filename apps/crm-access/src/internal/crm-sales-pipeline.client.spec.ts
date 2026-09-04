import {
	ConflictException,
	HttpException,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
	CrmSalesPipelineClient,
	type InstallCrmSalesPipelineCommand
} from './crm-sales-pipeline.client';

const TOKEN = 'crm-sales-access-test-token-at-least-32-characters';
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const INITIAL_COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const PIPELINE_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const TEMPLATE_FINGERPRINT = 'a'.repeat(64);

function config(values: Record<string, string>) {
	return {
		get: jest.fn((key: string) => values[key])
	} as unknown as ConfigService;
}

function client(overrides: Record<string, string> = {}) {
	return new CrmSalesPipelineClient(
		config({
			CRM_SALES_CRM_ACCESS_TOKEN: TOKEN,
			CRM_SALES_INTERNAL_BASE_URL: 'http://127.0.0.1:5330',
			CRM_SALES_INTERNAL_TIMEOUT_MS: '10000',
			...overrides
		})
	);
}

const command = (): InstallCrmSalesPipelineCommand => ({
	schemaVersion: 1,
	commandId: COMMAND_ID,
	workspaceId: WORKSPACE_ID,
	templateKey: 'universal-sales',
	templateVersion: 1,
	installedBySubject: 'user-1'
});

const installation = () => ({
	initialCommandId: INITIAL_COMMAND_ID,
	workspaceId: WORKSPACE_ID,
	pipelineId: PIPELINE_ID,
	templateKey: 'universal-sales',
	templateVersion: 1,
	templateFingerprint: TEMPLATE_FINGERPRINT
});

const installResponse = () => ({
	schemaVersion: 1,
	installation: {
		commandId: COMMAND_ID,
		...installation()
	}
});

const summaryResponse = () => ({
	schemaVersion: 1,
	installation: installation()
});

const jsonResponse = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' }
	});

async function captureHttpException(
	promise: Promise<unknown>
): Promise<HttpException> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof HttpException) return error;
		throw error;
	}
	throw new Error('Expected request to reject with HttpException');
}

describe('CrmSalesPipelineClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it('sends the exact internal installation DTO and service credentials', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(jsonResponse(installResponse()));

		await expect(
			client().installTemplate(command(), CORRELATION_ID)
		).resolves.toEqual(installResponse());
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(
			'http://127.0.0.1:5330/internal/v1/crm-access/pipelines/install-template'
		);
		const request = fetchMock.mock.calls[0][1] as RequestInit;
		expect(request.method).toBe('POST');
		expect(request.headers).toEqual({
			'content-type': 'application/json',
			'idempotency-key': COMMAND_ID,
			accept: 'application/json',
			'x-winwidget-service': 'crm-access',
			'x-winwidget-internal-token': TOKEN,
			'x-correlation-id': CORRELATION_ID
		});
		expect(request.headers).not.toHaveProperty('authorization');
		expect(JSON.parse(String(request.body))).toEqual(command());
	});

	it('gets an exact immutable installation summary without an idempotency header', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(jsonResponse(summaryResponse()));

		await expect(
			client().getInstallation(WORKSPACE_ID, CORRELATION_ID)
		).resolves.toEqual(summaryResponse());
		expect(fetchMock.mock.calls[0][0]).toBe(
			`http://127.0.0.1:5330/internal/v1/crm-access/pipelines/workspaces/${WORKSPACE_ID}/installation`
		);
		const request = fetchMock.mock.calls[0][1] as RequestInit;
		expect(request.method).toBe('GET');
		expect(request.headers).toEqual({
			accept: 'application/json',
			'x-winwidget-service': 'crm-access',
			'x-winwidget-internal-token': TOKEN,
			'x-correlation-id': CORRELATION_ID
		});
	});

	it('maps only the exact template-not-found body to a public 404 code', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			jsonResponse(
				{
					message: 'Pipeline template version was not found',
					code: 'crm_template_version_not_found'
				},
				404
			)
		);

		const error = await captureHttpException(
			client().installTemplate(command(), CORRELATION_ID)
		);
		expect(error).toBeInstanceOf(NotFoundException);
		expect(error.getResponse()).toEqual({
			message: 'Pipeline template version was not found',
			code: 'crm_template_version_not_found'
		});
	});

	it.each([
		[
			'crm_pipeline_already_initialized',
			'Workspace pipeline is already initialized'
		],
		[
			'crm_pipeline_install_command_conflict',
			'Command ID conflicts with a previous pipeline installation'
		]
	] as const)(
		'preserves recognized conflict code %s',
		async (code, message) => {
			jest
				.spyOn(global, 'fetch')
				.mockResolvedValue(
					jsonResponse({ message: 'upstream message', code }, 409)
				);

			const error = await captureHttpException(
				client().installTemplate(command(), CORRELATION_ID)
			);
			expect(error).toBeInstanceOf(ConflictException);
			expect(error.getResponse()).toEqual({ message, code });
		}
	);

	it.each([
		[404, { message: 'missing', code: 'unknown_not_found' }],
		[
			404,
			{
				message: 'missing',
				code: 'crm_template_version_not_found',
				statusCode: 404
			}
		],
		[409, { message: 'conflict', code: 'unknown_conflict' }],
		[409, { code: 'crm_pipeline_already_initialized' }]
	])(
		'maps unrecognized or drifted HTTP %s error DTO to dependency failure',
		async (status, body) => {
			jest
				.spyOn(global, 'fetch')
				.mockResolvedValue(jsonResponse(body, status));
			await expect(
				client().installTemplate(command(), CORRELATION_ID)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);

	it('returns null only for the exact installation-not-found error', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			jsonResponse(
				{
					message: 'Workspace pipeline installation was not found',
					code: 'crm_pipeline_installation_not_found'
				},
				404
			)
		);
		await expect(
			client().getInstallation(WORKSPACE_ID, CORRELATION_ID)
		).resolves.toBeNull();
	});

	it('maps a different 404 from installation lookup to dependency failure', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			jsonResponse(
				{
					message: 'Route was not found',
					code: 'crm_template_version_not_found'
				},
				404
			)
		);
		const error = await captureHttpException(
			client().getInstallation(WORKSPACE_ID, CORRELATION_ID)
		);
		expect(error).toBeInstanceOf(ServiceUnavailableException);
		expect(error.getResponse()).toEqual({
			message: 'CRM Sales service is unavailable',
			code: 'crm_sales_unavailable'
		});
	});

	it.each([
		['extra top-level key', () => ({ ...installResponse(), extra: true })],
		[
			'wrong command ID',
			() => ({
				...installResponse(),
				installation: {
					...installResponse().installation,
					commandId: INITIAL_COMMAND_ID
				}
			})
		],
		[
			'wrong workspace',
			() => ({
				...installResponse(),
				installation: {
					...installResponse().installation,
					workspaceId: '66666666-6666-4666-8666-666666666666'
				}
			})
		],
		[
			'wrong template pair',
			() => ({
				...installResponse(),
				installation: {
					...installResponse().installation,
					templateVersion: 2
				}
			})
		],
		[
			'uppercase fingerprint',
			() => ({
				...installResponse(),
				installation: {
					...installResponse().installation,
					templateFingerprint: TEMPLATE_FINGERPRINT.toUpperCase()
				}
			})
		],
		[
			'oversized template key',
			() => ({
				...installResponse(),
				installation: {
					...installResponse().installation,
					templateKey: `a${'b'.repeat(64)}`
				}
			})
		]
	] as const)(
		'fails closed for success contract drift: %s',
		async (_caseName, responseFactory) => {
			jest
				.spyOn(global, 'fetch')
				.mockResolvedValue(jsonResponse(responseFactory()));
			await expect(
				client().installTemplate(command(), CORRELATION_ID)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);

	it('fails closed for an invalid summary workspace', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			jsonResponse({
				...summaryResponse(),
				installation: {
					...summaryResponse().installation,
					workspaceId: '66666666-6666-4666-8666-666666666666'
				}
			})
		);
		await expect(
			client().getInstallation(WORKSPACE_ID, CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it.each([
		[new Response(null, { status: 500 })],
		[new Response('{invalid-json', { status: 200 })]
	])('fails closed for an invalid dependency response', async response => {
		jest.spyOn(global, 'fetch').mockResolvedValue(response);
		await expect(
			client().installTemplate(command(), CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('fails closed when CRM Sales is unreachable', async () => {
		jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
		await expect(
			client().installTemplate(command(), CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
