// Backup-only endpoints: these are not main-Compose runtime or restore targets.
const CRM_BACKUP_TARGETS = Object.freeze(
	[
		['CRM_ACCESS_BACKUP_URL', 'crm_access', '55442'],
		['CRM_INTAKE_BACKUP_URL', 'crm_intake', '55443'],
		['CRM_CUSTOMERS_BACKUP_URL', 'crm_customers', '55444'],
		['CRM_SALES_BACKUP_URL', 'crm_sales', '55445']
	].map(target => Object.freeze(target))
);

const validateCrmBackupBoundary = (services, expected) => {
	const fail = () => {
		throw new Error('CRM backup-only process boundary is invalid');
	};
	if (!services['operations-worker']) fail();
	for (const [key, schema, port] of CRM_BACKUP_TARGETS) {
		for (const [name, service] of Object.entries(services)) {
			if (
				Object.hasOwn(service.environment ?? {}, key) !==
				(name === 'operations-worker')
			)
				fail();
		}
		const value = services['operations-worker'].environment?.[key];
		if (typeof value !== 'string' || !value || value !== expected(key))
			fail();
		let url;
		try {
			url = new URL(value);
		} catch {
			fail();
		}
		if (
			url.protocol !== 'postgresql:' ||
			url.hostname !== '127.0.0.1' ||
			url.port !== port ||
			url.pathname !== `/winwidget_${schema}` ||
			url.hash ||
			!url.password ||
			url.searchParams.get('schema') !== schema ||
			url.searchParams.get('sslmode') !== 'disable' ||
			[...url.searchParams.keys()].sort().join(',') !== 'schema,sslmode'
		)
			fail();
		let principal;
		try {
			principal = decodeURIComponent(url.username);
		} catch {
			fail();
		}
		if (principal !== `winwidget_${schema}_backup`) fail();
	}
};

module.exports = { CRM_BACKUP_TARGETS, validateCrmBackupBoundary };
