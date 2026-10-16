// O Claude Code copia só a pasta do plugin. Este subconjunto dos dicionários compartilhados
// fica aqui para funcionar sem imports externos; server/test/mod-i18n.test.ts confere a paridade.
const dictionaries: Record<string, Readonly<Record<string, string>>> = {
  "en": {
    "responder no terminal": "answer in the terminal",
    "🏢 {0} precisa de você em {1}": "🏢 {0} needs you in {1}",
    "🏢 {0} precisam de você: {1}{2}": "🏢 {0} need you: {1}{2}",
    " e mais {0}": " and {0} more",
    "1 agente": "1 agent",
    "{0} agentes": "{0} agents",
    "ninguém precisa de você": "nobody needs you",
    "1 precisa de você": "1 needs you",
    "{0} precisam de você": "{0} need you",
    "Habblaud {0} em {1}": "Habblaud {0} at {1}",
    "{0} · {1} trabalhando · {2}": "{0} · {1} working · {2}",
    " · dá para responder pelo escritório": " · you can reply from the office",
    "O Habblaud não respondeu em {0}. Para subir: npm run docker:up na pasta do Habblaud.": "Habblaud did not respond at {0}. To start it: npm run docker:up in the Habblaud folder.",
    "O Habblaud em {0} está numa versão sem a rota do mod. Para atualizar: git pull e npm run docker:up na pasta do Habblaud.": "Habblaud at {0} is running a version without the mod endpoint. To update: git pull and npm run docker:up in the Habblaud folder.",
    "Resumo do Habblaud: quantos agentes, quem trabalha e quem precisa de você": "Habblaud summary: agent counts, who is working and who needs you"
  },
  "es": {
    "responder no terminal": "responder en la terminal",
    "🏢 {0} precisa de você em {1}": "🏢 {0} te necesita en {1}",
    "🏢 {0} precisam de você: {1}{2}": "🏢 {0} te necesitan: {1}{2}",
    " e mais {0}": " y {0} más",
    "1 agente": "1 agente",
    "{0} agentes": "{0} agentes",
    "ninguém precisa de você": "nadie te necesita",
    "1 precisa de você": "1 te necesita",
    "{0} precisam de você": "{0} te necesitan",
    "Habblaud {0} em {1}": "Habblaud {0} en {1}",
    "{0} · {1} trabalhando · {2}": "{0} · {1} trabajando · {2}",
    " · dá para responder pelo escritório": " · puedes responder desde la oficina",
    "O Habblaud não respondeu em {0}. Para subir: npm run docker:up na pasta do Habblaud.": "Habblaud no respondió en {0}. Para iniciarlo: npm run docker:up en la carpeta de Habblaud.",
    "O Habblaud em {0} está numa versão sem a rota do mod. Para atualizar: git pull e npm run docker:up na pasta do Habblaud.": "Habblaud en {0} usa una versión sin la ruta del mod. Para actualizar: git pull y npm run docker:up en la carpeta de Habblaud.",
    "Resumo do Habblaud: quantos agentes, quem trabalha e quem precisa de você": "Resumen de Habblaud: cuántos agentes hay, quién trabaja y quién te necesita"
  },
  "fr": {
    "responder no terminal": "répondre dans le terminal",
    "🏢 {0} precisa de você em {1}": "🏢 {0} a besoin de vous dans {1}",
    "🏢 {0} precisam de você: {1}{2}": "🏢 {0} ont besoin de vous : {1}{2}",
    " e mais {0}": " et {0} autres",
    "1 agente": "1 agent",
    "{0} agentes": "{0} agents",
    "ninguém precisa de você": "personne n’a besoin de vous",
    "1 precisa de você": "1 a besoin de vous",
    "{0} precisam de você": "{0} ont besoin de vous",
    "Habblaud {0} em {1}": "Habblaud {0} sur {1}",
    "{0} · {1} trabalhando · {2}": "{0} · {1} au travail · {2}",
    " · dá para responder pelo escritório": " · vous pouvez répondre depuis le bureau",
    "O Habblaud não respondeu em {0}. Para subir: npm run docker:up na pasta do Habblaud.": "Habblaud ne répond pas sur {0}. Pour le démarrer : npm run docker:up dans le dossier Habblaud.",
    "O Habblaud em {0} está numa versão sem a rota do mod. Para atualizar: git pull e npm run docker:up na pasta do Habblaud.": "Habblaud sur {0} utilise une version sans la route du mod. Pour le mettre à jour : git pull et npm run docker:up dans le dossier Habblaud.",
    "Resumo do Habblaud: quantos agentes, quem trabalha e quem precisa de você": "Résumé de Habblaud : nombre d’agents, qui travaille et qui a besoin de vous"
  }
}

let locale = 'pt'

/** HABBLAUD_LANG explícito; sem configuração, preserva o português. */
export function setLanguage(value: string | undefined): void {
  locale = (value ?? '').trim().toLowerCase().split(/[-_.]/)[0]
}

export function tr(src: string, args: readonly unknown[] = []): string {
  const text = dictionaries[locale]?.[src] ?? src
  return text.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match)
}
