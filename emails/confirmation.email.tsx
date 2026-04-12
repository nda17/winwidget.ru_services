import * as React from 'react';

const VerificationEmail = ({ code }: { code: string }) => {
	return (
		<div>
			<h1>Ваш код подтверждения</h1>

			<p>
				Вы получили это письмо, потому что кто-то указал его при
				регистрации в сервисе winwidget.ru. Если это были вы, используйте
				код ниже, чтобы подтвердить свой адрес электронной почты.
			</p>

			<p
				style={{
					fontSize: '2rem',
					fontWeight: 700,
					letterSpacing: '.3rem'
				}}
			>
				{code}
			</p>

			<p>Код действует 10 минут.</p>

			<p
				style={{
					color: '#FC0303'
				}}
			>
				Это письмо было сгенерировано и отправлено роботом. Вам не нужно
				отвечать на него. Если у вас есть вопрос, пожалуйста, свяжитесь с
				нами по адресу info@winwidget.ru
			</p>
		</div>
	);
};

export default VerificationEmail;
