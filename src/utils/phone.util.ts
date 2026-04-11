export const normalizePhone = (phone: string) => {
	const digits = phone.replace(/\D/g, '')

	if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
		return `+7${digits.slice(1)}`
	}

	if (digits.length === 10) {
		return `+7${digits}`
	}

	if (digits.length > 0 && phone.trim().startsWith('+')) {
		return `+${digits}`
	}

	return phone.trim()
}
