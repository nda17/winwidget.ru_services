import {
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	hasExactKeys,
	isRecord,
	isUuidV4,
	parseInternalBaseUrl,
	parseInternalTimeout,
	parseInternalToken,
	readBoundedJson
} from './internal-http.config';

export interface InstallCrmSalesPipelineCommand {
	schemaVersion: 1;
	commandId: string;
	workspaceId: string;
	templateKey: string;
	templateVersion: number;
	installedBySubject: string;
}

export interface CrmSalesPipelineInstallation {
	initialCommandId: string;
	workspaceId: string;
	pipelineId: string;
	templateKey: string;
	templateVersion: number;
	templateFingerprint: string;
}

export interface CrmSalesPipelineInstallationResponse {
	schemaVersion: 1;
	installation: CrmSalesPipelineInstallation & { commandId: string };
}

export interface CrmSalesPipelineInstallationSummary {
	schemaVersion: 1;
	installation: CrmSalesPipelineInstallation;
}

const TOKEN_PLACEHOLDERS = [
	'crm_sales_crm_access_token',
	'ci_crm_sales_crm_access_token_at_least_32_chars'
];
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_MESSAGES = {
	crm_pipeline_already_initialized:
		'Workspace pipeline is already initialized',
	crm_pipeline_install_command_conflict:
		'Command ID conflicts with a previous pipeline installation',
	crm_pipeline_installation_not_found:
		'Workspace pipeline installation was not found',
	crm_template_version_not_found: 'Pipeline template version was not found'
} as const;
type CrmSalesErrorCode = keyof typeof ERROR_MESSAGES;
const INSTALL_NOT_FOUND_CODES = new Set<CrmSalesErrorCode>([
	'crm_template_version_not_found'
]);
const INSTALLATION_NOT_FOUND_CODES = new Set<CrmSalesErrorCode>([
	'crm_pipeline_installation_not_found'
]);
const RECOGNIZED_CONFLICT_CODES = new Set<CrmSalesErrorCode>([
	'crm_pipeline_already_initialized',
	'crm_pipeline_install_command_conflict'
]);

@Injectable()
export class CrmSalesPipelineClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly token: string;

	constructor(config: ConfigService) {
		this.baseUrl = parseInternalBaseUrl(
			'CRM_SALES_INTERNAL_BASE_URL',
			config.get<string>('CRM_SALES_INTERNAL_BASE_URL'),
			'http://127.0.0.1:5330'
		);
		this.timeoutMs = parseInternalTimeout(
			'CRM_SALES_INTERNAL_TIMEOUT_MS',
			config.get<string>('CRM_SALES_INTERNAL_TIMEOUT_MS')
		);
		this.token = parseInternalToken(
			'CRM_SALES_CRM_ACCESS_TOKEN',
			config.get<string>('CRM_SALES_CRM_ACCESS_TOKEN'),
			TOKEN_PLACEHOLDERS
		);
	}

	async installTemplate(
		command: InstallCrmSalesPipelineCommand,
		correlationId: string
	): Promise<CrmSalesPipelineInstallationResponse> {
		const response = await this.request(
			'/internal/v1/crm-access/pipelines/install-template',
			correlationId,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': command.commandId
				},
				body: JSON.stringify(command)
			}
		);
		const value = await this.readResponse(response);
		if (response.status === 404) {
			const code = this.recognizedErrorCode(
				value,
				INSTALL_NOT_FOUND_CODES
			);
			if (code) {
				throw new NotFoundException({
					message: ERROR_MESSAGES[code],
					code
				});
			}
			throw this.unavailable();
		}
		if (response.status === 409) {
			const code = this.recognizedErrorCode(
				value,
				RECOGNIZED_CONFLICT_CODES
			);
			if (code) {
				throw new ConflictException({
					message: ERROR_MESSAGES[code],
					code
				});
			}
			throw this.unavailable();
		}
		if (!response.ok || !this.isInstallResponse(value, command)) {
			throw this.unavailable();
		}
		return value;
	}

	async getInstallation(
		workspaceId: string,
		correlationId: string
	): Promise<CrmSalesPipelineInstallationSummary | null> {
		const response = await this.request(
			`/internal/v1/crm-access/pipelines/workspaces/${workspaceId}/installation`,
			correlationId,
			{ method: 'GET' }
		);
		const value = await this.readResponse(response);
		if (response.status === 404) {
			if (
				this.recognizedErrorCode(value, INSTALLATION_NOT_FOUND_CODES) ===
				'crm_pipeline_installation_not_found'
			) {
				return null;
			}
			throw this.unavailable();
		}
		if (!response.ok || !this.isSummaryResponse(value, workspaceId)) {
			throw this.unavailable();
		}
		return value;
	}

	private async request(
		path: string,
		correlationId: string,
		init: RequestInit
	): Promise<Response> {
		try {
			return await fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					...init.headers,
					accept: 'application/json',
					'x-winwidget-service': 'crm-access',
					'x-winwidget-internal-token': this.token,
					'x-correlation-id': correlationId
				},
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch {
			throw this.unavailable();
		}
	}

	private async readResponse(response: Response): Promise<unknown> {
		try {
			return await readBoundedJson(response);
		} catch {
			throw this.unavailable();
		}
	}

	private isInstallResponse(
		value: unknown,
		command: InstallCrmSalesPipelineCommand
	): value is CrmSalesPipelineInstallationResponse {
		return (
			isRecord(value) &&
			hasExactKeys(value, ['installation', 'schemaVersion']) &&
			value.schemaVersion === 1 &&
			this.isInstallation(value.installation, command.workspaceId, true) &&
			value.installation.commandId === command.commandId &&
			value.installation.templateKey === command.templateKey &&
			value.installation.templateVersion === command.templateVersion
		);
	}

	private isSummaryResponse(
		value: unknown,
		workspaceId: string
	): value is CrmSalesPipelineInstallationSummary {
		return (
			isRecord(value) &&
			hasExactKeys(value, ['installation', 'schemaVersion']) &&
			value.schemaVersion === 1 &&
			this.isInstallation(value.installation, workspaceId, false)
		);
	}

	private isInstallation(
		value: unknown,
		workspaceId: string,
		withCommandId: boolean
	): value is CrmSalesPipelineInstallation & { commandId?: string } {
		if (!isRecord(value)) return false;
		const keys = [
			'initialCommandId',
			'pipelineId',
			'templateFingerprint',
			'templateKey',
			'templateVersion',
			'workspaceId',
			...(withCommandId ? ['commandId'] : [])
		];
		return (
			hasExactKeys(value, keys) &&
			(!withCommandId || isUuidV4(value.commandId)) &&
			isUuidV4(value.initialCommandId) &&
			value.workspaceId === workspaceId &&
			isUuidV4(value.workspaceId) &&
			isUuidV4(value.pipelineId) &&
			typeof value.templateKey === 'string' &&
			value.templateKey.length <= 64 &&
			KEY_PATTERN.test(value.templateKey) &&
			typeof value.templateVersion === 'number' &&
			Number.isInteger(value.templateVersion) &&
			value.templateVersion >= 1 &&
			value.templateVersion <= 32_767 &&
			typeof value.templateFingerprint === 'string' &&
			FINGERPRINT_PATTERN.test(value.templateFingerprint)
		);
	}

	private recognizedErrorCode(
		value: unknown,
		allowed: ReadonlySet<CrmSalesErrorCode>
	): CrmSalesErrorCode | null {
		if (
			!isRecord(value) ||
			!hasExactKeys(value, ['code', 'message']) ||
			typeof value.code !== 'string' ||
			!allowed.has(value.code as CrmSalesErrorCode) ||
			typeof value.message !== 'string' ||
			!value.message.trim() ||
			value.message !== value.message.trim() ||
			value.message.length > 500
		) {
			return null;
		}
		return value.code as CrmSalesErrorCode;
	}

	private unavailable(): ServiceUnavailableException {
		return new ServiceUnavailableException({
			message: 'CRM Sales service is unavailable',
			code: 'crm_sales_unavailable'
		});
	}
}
