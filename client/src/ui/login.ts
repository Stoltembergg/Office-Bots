// Tela de login do modo remoto (servidor com HABBLAUD_PASSWORD): uma camada simples por cima do escritório, com o
// campo de senha. Resolve quando o servidor aceita a senha; o resto (conectar, reconectar) fica por conta de quem chamou.
import { login, type LoginResult } from '../net/auth';
import { h, setHidden, setText } from './dom';
import { wordmark } from './widgets';

/** Mensagem de cada resultado do login ('ok' não tem). */
export const LOGIN_MESSAGES: Record<Exclude<LoginResult, 'ok'>, string> = {
  unauthorized: 'Senha incorreta',
  rate_limited: 'Tente de novo em um minuto',
  error: 'Não foi possível falar com o Habblaud',
};

export interface LoginOptions {
  /** A sessão acabou no meio do uso: mostra o aviso (em vez do convite normal). */
  expired?: boolean;
  /** Onde montar (padrão: document.body). */
  parent?: HTMLElement;
}

/** Mostra a tela de login e resolve depois que a senha foi aceita (a tela some). */
export function showLogin(opts: LoginOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'ui-login__input', type: 'password', attrs: { id: 'ui-login-pw', name: 'password', autocomplete: 'current-password', required: true, 'aria-describedby': 'ui-login-err' } });
    const submit = h('button', { class: 'ui-btn ui-btn--primary ui-login__submit', type: 'submit', text: 'Entrar' });
    const error = h('p', { class: 'ui-login__error', role: 'alert', hidden: true, attrs: { id: 'ui-login-err' } });
    const form = h(
      'form',
      { class: 'ui-login__form', attrs: { novalidate: true } },
      h('label', { class: 'ui-login__label', text: 'Senha', attrs: { for: 'ui-login-pw' } }),
      input,
      submit,
      error,
    );
    const note = h('p', { class: 'ui-login__note', text: opts.expired ? 'Sua sessão acabou. Entre de novo para continuar.' : 'Este Habblaud pede senha para abrir de fora do computador.' });
    const el = h('div', { class: 'ui-login', attrs: { 'data-login': '' } }, h('div', { class: 'ui-login__box' }, wordmark('ui-login__name'), note, form));

    let busy = false;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pw = input.value;
      if (busy || !pw) return;
      busy = true;
      submit.disabled = true;
      setHidden(error, true);
      const result = await login(pw);
      busy = false;
      submit.disabled = false;
      if (result === 'ok') {
        el.remove();
        resolve();
        return;
      }
      setText(error, LOGIN_MESSAGES[result]);
      setHidden(error, false);
      input.select();
    });

    (opts.parent ?? document.body).append(el);
    input.focus();
  });
}
