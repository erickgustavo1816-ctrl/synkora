// O CARDÁPIO DA RELEASE DIRETA no modal de missão nova (ordem do dono,
// 2026-09-28): a versão ATUAL (só a release pode nascer nela), as abertas e as
// NOVAS sugeridas (patch/minor/major). A régua de quais versões existentes
// valem mora no contrato compartilhado com o main; as sugestões de número são
// as MESMAS da versão nova (versionChoice). Módulo puro — o modal só desenha.

import {
  directReleaseTargets,
  type DirectReleaseInput,
  type DirectReleaseVersion
} from '../../shared/directRelease'
import { versionSuggestions } from './versionChoice'

export type DirectReleaseChoice =
  | { kind: 'current' | 'open'; value: string; name: string; label: string; hint: string; versionId: string }
  | { kind: 'new'; value: string; name: string; label: string; hint: string; newVersionName: string }

export function directReleaseChoices(
  versions: readonly DirectReleaseVersion[],
  manifestVersion?: string | null
): DirectReleaseChoice[] {
  const existing = directReleaseTargets(versions).map((target): DirectReleaseChoice => ({
    kind: target.kind,
    value: `${target.kind}:${target.versionId}`,
    name: target.name,
    versionId: target.versionId,
    label: `◈ ${target.name} — ${target.kind === 'current' ? 'atual, na main' : 'em desenvolvimento'}`,
    hint: target.kind === 'current' ? 'correção direto na main, sem número novo' : 'a subida publica com este número'
  }))
  const fresh = versionSuggestions(versions, manifestVersion).map((suggestion): DirectReleaseChoice => ({
    kind: 'new',
    value: `new:${suggestion.label}`,
    name: suggestion.label,
    newVersionName: suggestion.label,
    label: `+ ${suggestion.label} — nova`,
    hint: suggestion.kind
  }))
  return [...existing, ...fresh]
}

/** O pedido que viaja para o main — um destino só, nunca os dois. */
export function directReleaseInput(title: string, choice: DirectReleaseChoice): DirectReleaseInput {
  return choice.kind === 'new'
    ? { title: title.trim(), newVersionName: choice.newVersionName }
    : { title: title.trim(), versionId: choice.versionId }
}

/** A frase sob o seletor: o que acontece com a correção em cada destino. */
export function directReleaseNote(choice: DirectReleaseChoice | undefined): string {
  if (!choice) return 'escolha onde a correção vai subir'
  if (choice.kind === 'current')
    return 'a correção vai direto na main, sem número novo — o app instalado não recebe pela atualização automática; para isso, escolha uma versão nova'
  if (choice.kind === 'open')
    return `a correção entra na branch da ${choice.name} e a subida publica com esse número`
  return `a ${choice.name} nasce agora, com branch própria, e a subida publica com esse número`
}
