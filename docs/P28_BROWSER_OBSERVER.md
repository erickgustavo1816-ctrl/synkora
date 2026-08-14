# P28 — observador local do navegador

## Alcance entregue

O painel do chat acompanha passivamente a última imagem física encontrada em
`<cwd do pane>/.playwright-mcp` ou `<cwd do pane>/.synkora/attachments`. Ele
mostra somente fatos que o arquivo fornece: imagem, nome, raiz local de origem,
MIME, tamanho, `mtime`, momento em que foi observado e dimensões quando o
formato permite validá-las.

Esta é deliberadamente a implementação barata prevista no plano. A sessão GUI
direct não recebe eventos do Playwright MCP por esta ponte e o P28 não injeta
essa capacidade. Portanto o painel:

- não abre nem dirige navegador;
- não lê uma página ou testa um site;
- não conhece URL, título, clique, seletor ou posição do cursor;
- não infere esses dados pelo nome do arquivo nem pelo texto da conversa.

O agente continua usando somente as ferramentas que o próprio pane já recebeu.
O painel é uma janela de acompanhamento para arquivos locais, não um controle
do computador.

## Fronteira e limites

O renderer envia apenas o `paneId` e, ao pedir os bytes, o token opaco do frame
corrente. O main resolve o `cwd` pelo `GuiSessionRegistry`, limita as raízes às
duas casas acima e recusa arquivo ou diretório que seja link/junction, escape da
raiz física, tipo não suportado, assinatura incompatível, identidade trocada ou
imagem acima de 5 MB.

Há no máximo 12 panes em observação, quatro watchers por pane e 512 entradas
examinadas por raiz. Rajadas são agrupadas numa atualização a cada 140 ms. O
main conserva apenas metadados e o caminho do frame corrente; os bytes cruzam o
IPC sob demanda e não entram em cache. O renderer usa um Blob URL temporário e
o revoga na troca ou desmontagem.

`parar` fecha todos os watchers daquele pane e mantém somente a referência à
última imagem para a interface continuar mostrando a fotografia já vista. Fechar
ou respawnar o pane remove também essa referência; sair do app fecha todos os
watchers.

## Costura extensível

O contrato separado `BrowserObserverSnapshot` permite acrescentar fatos
opcionais no futuro. URL, título e interação só devem entrar quando houver uma
fonte autenticada e pane-scoped (por exemplo, uma ponte explícita do Playwright
MCP), sempre como campos ausentes quando a fonte não os entregou. A UI atual não
reserva placeholders nem inventa valores para essa fase futura.
