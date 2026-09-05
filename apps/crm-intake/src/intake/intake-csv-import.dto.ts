import { Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsEmail,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	ValidateIf,
	ValidateNested
} from 'class-validator';
import { IntakeCommandDto } from './intake.dto';

// Match the UTF-8 CSV preview contract: preserve tabs/newlines and valid Unicode,
// but reject control bytes, replacement characters and unpaired surrogates.
export const CSV_TEXT_PATTERN =
	/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd\ud800-\udfff]*$/u;

export class IntakeCsvRowDto {
	@IsString()
	@MaxLength(200)
	@Matches(/\S/)
	@Matches(CSV_TEXT_PATTERN, {
		message: 'title contains unsupported characters'
	})
	title!: string;
	@IsString()
	@MaxLength(200)
	@Matches(/\S/)
	@Matches(CSV_TEXT_PATTERN, {
		message: 'name contains unsupported characters'
	})
	name!: string;
	@ValidateIf((_, value) => value !== null)
	@Matches(/^\+[1-9][0-9]{6,14}$/)
	@Matches(CSV_TEXT_PATTERN, {
		message: 'phone contains unsupported characters'
	})
	phone!: string | null;
	@ValidateIf((_, value) => value !== null)
	@IsEmail()
	@MaxLength(254)
	@Matches(CSV_TEXT_PATTERN, {
		message: 'email contains unsupported characters'
	})
	email!: string | null;
	@ValidateIf((_, value) => value !== null)
	@IsString()
	@MaxLength(5000)
	@Matches(CSV_TEXT_PATTERN, {
		message: 'message contains unsupported characters'
	})
	message!: string | null;
}

export class ImportIntakeCsvDto extends IntakeCommandDto {
	@IsString()
	@MaxLength(200)
	@Matches(/\S/)
	@Matches(/^[^/\\\x00-\x1f\x7f]+$/)
	@Matches(CSV_TEXT_PATTERN, {
		message: 'label contains unsupported characters'
	})
	label!: string;
	@ValidateIf((_, value) => value !== null)
	@IsUUID('4')
	teamId!: string | null;
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(250)
	@ValidateNested({ each: true })
	@Type(() => IntakeCsvRowDto)
	rows!: IntakeCsvRowDto[];
}
