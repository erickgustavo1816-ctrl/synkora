# Security Policy

*(Português abaixo.)*

## Security maintainer

Synkora's security maintainer is **Erick** ([@erickgustavo1816-ctrl](https://github.com/erickgustavo1816-ctrl)), who is also the project's author. Synkora is maintained by one person, so the response times below are goals, not guarantees.

## Supported versions

Only the latest released version receives security fixes. The installed app on Windows updates itself automatically, so fixes reach users through a new release.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Include:

- what is affected (file, function, IPC channel, MCP tool, setting);
- steps to reproduce, using synthetic data;
- the impact you expect and the version or commit you tested.

Please do not include real credentials, tokens, or other people's personal data in a report.

What to expect:

- acknowledgment within **7 days**;
- an initial assessment within **14 days**;
- a fix or mitigation as soon as practical, coordinated with you before any public disclosure;
- credit in the advisory if you want it.

## Scope

In scope: the code in this repository, including the Electron main and preload processes, the renderer, the local MCP server, worktree and Git handling, how the app launches and isolates the AI CLIs, and the update mechanism.

Out of scope:

- vulnerabilities in the AI CLIs themselves (Claude Code, Codex) or in Electron, Node.js and other dependencies. Report those to their maintainers; tell us too if Synkora's use of them makes the problem worse;
- the third-party skills under `build/skills/` (see `THIRD_PARTY_NOTICES.md`). Report those upstream;
- issues that require an attacker who already controls the user's account or machine.

## Safe harbor

Good-faith research on your own installation, following this policy, is welcome. Do not access data that is not yours, do not degrade other people's systems, and give a reasonable time to fix before disclosing.

---

## Português

**Mantenedor de segurança:** Erick ([@erickgustavo1816-ctrl](https://github.com/erickgustavo1816-ctrl)), autor do projeto. O Synkora é mantido por uma pessoa só, então os prazos acima são metas.

**Para relatar uma vulnerabilidade, não abra uma issue pública.** Use a aba **Security** deste repositório → **Report a vulnerability**, com o que é afetado, como reproduzir com dados sintéticos e o impacto esperado. Não envie credenciais reais nem dados pessoais de terceiros.

Resposta inicial em até 7 dias e avaliação em até 14 dias. Correções são coordenadas com quem relatou antes de qualquer divulgação pública.
