import * as React from 'react';

const NewPasswordEmail = ({ password }: { password: string }) => {
	return (
		<div>
			<h1>Ваш временный пароль для входа</h1>

			<p>
				Вы получили это письмо, потому что данный адрес указали этот адрес
				в качестве адреса для получения нового временного пароля взамен
				забытого. Рекомендуем сменить временный пароль после входа в
				систему. Ваш новый временный пароль:
			</p>

			<p
				style={{
					fontSize: '2rem',
					fontWeight: 700,
					letterSpacing: '.3rem'
				}}
			>
				{password}
			</p>

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

export default NewPasswordEmail;
