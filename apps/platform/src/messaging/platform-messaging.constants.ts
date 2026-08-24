export const PLATFORM_EVENTS_EXCHANGE = 'winwidget.events';
export const PLATFORM_ADMIN_AUDIT_ROUTING_KEY = 'admin.audit.platform.v1';
export const PLATFORM_ADMIN_AUDIT_EVENT_TYPE = 'admin.audit.event.v1';

export const PLATFORM_EVENT_TYPES = {
	settingsChanged: 'platform.settings.changed.v1',
	legalPageChanged: 'platform.legal-page.changed.v1',
	homePageContentChanged: 'platform.home-page-content.changed.v1',
	adminAudit: PLATFORM_ADMIN_AUDIT_EVENT_TYPE
} as const;
