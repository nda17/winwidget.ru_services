import { BadRequestException } from '@nestjs/common';
import {
	IsOptional,
	IsString,
	MaxLength,
	MinLength
} from 'class-validator';

export class EmployeeNameDto {
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	firstName!: string;

	@IsString()
	@MinLength(1)
	@MaxLength(100)
	lastName!: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	middleName?: string | null;
}

export const normalizeEmployeeName = (profile: EmployeeNameDto) => {
	const name = (value: unknown): string => {
		if (typeof value !== 'string')
			throw new BadRequestException('Employee name is invalid');
		const normalized = value.normalize('NFC').trim().replace(/ +/g, ' ');
		if (
			normalized.length > 100 ||
			!/^[\p{L}\p{M}][\p{L}\p{M} .’'-]*$/u.test(normalized)
		)
			throw new BadRequestException('Employee name is invalid');
		return normalized;
	};
	return {
		firstName: name(profile.firstName),
		lastName: name(profile.lastName),
		middleName:
			profile.middleName === undefined ||
			profile.middleName === null ||
			profile.middleName === ''
				? null
				: name(profile.middleName)
	};
};

export const employeeDisplayName = (profile: {
	firstName: string;
	lastName: string;
	middleName: string | null;
}) =>
	[profile.lastName, profile.firstName, profile.middleName]
		.filter(Boolean)
		.join(' ');
