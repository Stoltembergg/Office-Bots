import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, tr } from '../../mod/habblaud/hooks/i18n';
import { EN } from '../../shared/locales/en';
import { ES } from '../../shared/locales/es';
import { FR } from '../../shared/locales/fr';

afterEach(() => setLanguage(undefined));

describe('traduções isoladas do mod', () => {
  it('aceita HABBLAUD_LANG regional e preserva o português sem idioma suportado', () => {
    setLanguage(' en_US.UTF-8 ');
    expect(tr('🏢 {0} precisa de você em {1}', ['Marina', 'shop'])).toBe('🏢 Marina needs you in shop');
    setLanguage('de');
    expect(tr('🏢 {0} precisa de você em {1}', ['Marina', 'shop'])).toBe('🏢 Marina precisa de você em shop');
    setLanguage(undefined);
    expect(tr('1 agente')).toBe('1 agente');
  });

  it('mantém todas as chaves do mod iguais aos dicionários compartilhados', () => {
    const source = readFileSync(new URL('../../mod/habblaud/hooks/register.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/\btr\('([^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const [locale, dict] of Object.entries({ en: EN, es: ES, fr: FR })) {
      setLanguage(locale);
      for (const key of keys) {
        expect(dict[key], `${locale}: ${key}`).toBeDefined();
        expect(tr(key), `${locale}: ${key}`).toBe(dict[key]);
      }
    }
  });
});
