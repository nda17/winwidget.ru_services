export function widgetTransfersEnabled(): boolean {
	const value = process.env.CRM_INTAKE_WIDGET_TRANSFERS_ENABLED ?? 'false';
	if (!['true', 'false'].includes(value))
		throw new Error('CRM_INTAKE_WIDGET_TRANSFERS_ENABLED must be boolean');
	if (
		value === 'true' &&
		process.env.CRM_INTAKE_WIDGETS_ENABLED !== 'true'
	)
		throw new Error('Widget transfers require managed Widgets enabled');
	return value === 'true';
}
