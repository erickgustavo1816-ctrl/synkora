# HANDOFF F6.3 - ajuste no mesmo card, gates somente leitura e retomada

O orquestrador da missao nao implementa produto. Um ajuste pequeno vai para o
dev ja aberto; se a entrega terminou, `run_task { adjustment }` reabre o mesmo
card em `fast`, preserva a conversa do dev e invalida apenas evidencias antigas.
Gate ativo termina antes da correcao ser aplicada. Escopo sensivel exige nova
classificacao/aprovacao, em vez de ser disfarcado como ajuste pequeno.

Review e QA agora possuem barreiras de processo: sandbox read-only no Codex,
hooks/MCPs herdados desativados e catalogo Synkora reduzido; Claude nao carrega
settings/hooks/plugins user/project/local e recebe somente ferramentas de
leitura e diagnostico. O backend confere a fotografia Git antes e depois de cada
gate e bloqueia veredito se o diff imutavel estiver ausente ou truncado.

O estado `pending` nasce antes do terminal e so vira `running` apos o spawn.
Falha/fechamento devolve a fase a `interrupted`, conserva worktree, transcript e
sessao retomavel. Reload visual reidrata panes realmente vivos; panes pendentes,
orfaos ou em fechamento nao podem renascer. Reservas atomicas impedem duas
aberturas do mesmo card e estouro concorrente do limite do projeto.

Validacao final: typecheck, build e 252 assertions automatizadas, alem dos
smokes MCP dual-era (32 clientes/22 tools) e Playwright. Pacote:
`release/workflow-readonly-recovery-final-20260801/win-unpacked/Synkora.exe`.
