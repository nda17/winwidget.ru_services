import { Injectable } from '@nestjs/common';
import type { WidgetsAuditInput } from '../messaging/widgets-domain-events.service';
import {
	WidgetUpdateInput,
	WidgetsConfigurationService
} from './widgets-configuration.service';
import type { WidgetType } from './widgets-domain.types';
import { WidgetsLeadQueryService } from './widgets-lead-query.service';
import { WidgetsLifecycleService } from './widgets-lifecycle.service';
import { WidgetsPublicService } from './widgets-public.service';
import type { WidgetLeadInput } from './widgets-type-adapter';

export type { WidgetUpdateInput } from './widgets-configuration.service';
export type LeadSubmissionInput = WidgetLeadInput;

/**
 * Thin compatibility facade for the existing controllers. Business ownership
 * is intentionally split between configuration, lifecycle, public lead flow,
 * and lead-query services.
 */
@Injectable()
export class WidgetsDomainService {
	constructor(
		private readonly configuration: WidgetsConfigurationService,
		private readonly lifecycle: WidgetsLifecycleService,
		private readonly publicFlow: WidgetsPublicService,
		private readonly leadQuery: WidgetsLeadQueryService
	) {}

	list(type: WidgetType, userId: string) {
		return this.configuration.list(type, userId);
	}

	create(
		type: WidgetType,
		userId: string,
		name: string | undefined,
		correlationId: string
	) {
		return this.configuration.create(type, userId, name, correlationId);
	}

	update(
		type: WidgetType,
		widgetId: string,
		userId: string,
		dto: WidgetUpdateInput,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		return this.configuration.update(
			type,
			widgetId,
			userId,
			dto,
			correlationId,
			audit
		);
	}

	delete(
		type: WidgetType,
		widgetId: string,
		userId: string,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		return this.configuration.delete(
			type,
			widgetId,
			userId,
			correlationId,
			audit
		);
	}

	uploadImage(
		type: WidgetType,
		widgetId: string,
		userId: string,
		file: Express.Multer.File | undefined,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		return this.configuration.uploadImage(
			type,
			widgetId,
			userId,
			file,
			expectedDraftRevision,
			correlationId,
			audit
		);
	}

	state(type: WidgetType, widgetId: string, userId: string) {
		return this.lifecycle.state(type, widgetId, userId);
	}

	publish(
		type: WidgetType,
		widgetId: string,
		userId: string,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		return this.lifecycle.publish(
			type,
			widgetId,
			userId,
			expectedDraftRevision,
			correlationId,
			audit
		);
	}

	versions(
		type: WidgetType,
		widgetId: string,
		userId: string,
		page: number,
		limit: number
	) {
		return this.lifecycle.versions(type, widgetId, userId, page, limit);
	}

	restore(
		type: WidgetType,
		widgetId: string,
		version: number,
		userId: string,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		return this.lifecycle.restore(
			type,
			widgetId,
			version,
			userId,
			expectedDraftRevision,
			correlationId,
			audit
		);
	}

	discard(
		type: WidgetType,
		widgetId: string,
		userId: string,
		expectedDraftRevision: number,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		return this.lifecycle.discard(
			type,
			widgetId,
			userId,
			expectedDraftRevision,
			correlationId,
			audit
		);
	}

	clone(
		type: WidgetType,
		widgetId: string,
		userId: string,
		name: string | undefined,
		correlationId: string,
		audit?: Pick<WidgetsAuditInput, 'actorId'>
	) {
		return this.lifecycle.clone(
			type,
			widgetId,
			userId,
			name,
			correlationId,
			audit
		);
	}

	publicConfig(
		type: WidgetType,
		publicKey: string,
		requestDomain: string | null,
		directPageAccessAllowed: boolean,
		ip: string
	) {
		return this.publicFlow.config(
			type,
			publicKey,
			requestDomain,
			directPageAccessAllowed,
			ip
		);
	}

	submitLead(
		type: WidgetType,
		publicKey: string,
		input: WidgetLeadInput,
		ip: string,
		requestDomain: string | null,
		directPageAccessAllowed: boolean,
		correlationId: string
	) {
		return this.publicFlow.submitLead(
			type,
			publicKey,
			input,
			ip,
			requestDomain,
			directPageAccessAllowed,
			correlationId
		);
	}

	leads(
		type: WidgetType,
		widgetId: string,
		userId: string,
		page: number,
		limit: number
	) {
		return this.leadQuery.list(type, widgetId, userId, page, limit);
	}

	stats(type: WidgetType, widgetId: string, userId: string) {
		return this.leadQuery.stats(type, widgetId, userId);
	}

	export(
		type: WidgetType,
		widgetId: string,
		userId: string,
		format: 'csv' | 'xlsx'
	) {
		return this.leadQuery.export(type, widgetId, userId, format);
	}

	adminGet(type: WidgetType, widgetId: string) {
		return this.lifecycle.adminGet(type, widgetId);
	}

	ownerId(type: WidgetType, widgetId: string) {
		return this.lifecycle.ownerId(type, widgetId);
	}
}
