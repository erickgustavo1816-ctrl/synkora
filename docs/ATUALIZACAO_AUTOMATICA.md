# Atualização automática do Synkora

O código continua no repositório **privado** `erickgustavo1816-ctrl/synkora`.
Os instaladores ficam no repositório **público**
`erickgustavo1816-ctrl/synkora-releases`.

## Como a atualização chega ao app

1. Uma versão nova chega à branch `main` do repositório privado.
2. O GitHub Actions verifica a versão, compila o app no Windows e publica a
   release `v<versão>` em `synkora-releases`, com o instalador e `latest.yml`.
3. O Synkora instalado consulta esse repositório público e baixa a atualização.
4. Ao reiniciar o app, a atualização é instalada silenciosamente, sem abrir
   uma janela do instalador.

O indicador de versão no app mostra o andamento. Esse fluxo vale para o app
instalado no Windows; a execução de desenvolvimento não instala atualizações.
A primeira instalação que contém o atualizador ainda precisa ser feita pelo
instalador. Depois disso, as versões seguintes chegam pelo próprio app.

## Configuração única no GitHub

1. Na conta `erickgustavo1816-ctrl`, crie o repositório **público**
   `synkora-releases`, vazio. Não copie o código privado para ele. Na primeira
   publicação, o workflow cria apenas um README público para permitir a tag.
2. Em **Settings → Developer settings → Personal access tokens → Fine-grained
   tokens**, crie um token. Escolha `erickgustavo1816-ctrl` como proprietário e
   limite o acesso ao repositório `synkora-releases`. Em **Repository
   permissions**, dê a **Contents** a permissão **Read and write**.
3. No repositório **privado** `synkora`, abra **Settings → Secrets and variables
   → Actions → New repository secret**. Salve o token com o nome exato
   `RELEASES_TOKEN`.

O token fica somente no secret do GitHub: não vai no app nem em arquivos do
projeto. Se ele expirar, gere outro com o mesmo acesso e atualize esse secret.
O repositório privado precisa ter o GitHub Actions habilitado.

## Publicar uma versão nova

O gatilho é aumentar `version` no `package.json` e levar essa mudança à `main`.
O fluxo de release do Synkora já faz esse aumento de versão. O workflow roda a
cada push, mas só compila e publica quando ainda não existe a tag `v<versão>`
em `synkora-releases`.

Se a release já existe, a execução termina com **release já publicada**.
Para tentar novamente uma versão que ainda não foi publicada, use
**Actions → Publicar instalador Windows → Run workflow**, na branch `main`.
Use versões estáveis, como `1.2.3`, para o canal automático `latest.yml`.

## Quando algo falhar

- **Actions:** no repositório privado, abra a execução de **Publicar instalador
  Windows** e veja qual etapa falhou. Erro de acesso costuma exigir conferir
  o secret `RELEASES_TOKEN`, sua validade e o acesso ao repositório público.
- **Artifact:** após a tentativa de empacotamento, a execução guarda
  `synkora-windows-<versão>` por **7 dias**, com os arquivos que foram gerados:
  instalador `.exe`, `.blockmap` e `latest.yml`. Se a compilação falhou antes,
  esses arquivos podem não existir.
- **Release pública:** confira em `synkora-releases` se a release está
  publicada, e se os três arquivos estão anexados. Um rascunho não chega ao app.
- **latest.yml:** é o índice que informa ao app a versão e o instalador a
  baixar. Ele precisa estar na release pública e corresponder ao `.exe`.
  O `.blockmap` ajuda a baixar apenas as partes necessárias da atualização.
- **Publicação incompleta:** se a tag já existe, executar novamente não troca
  seus arquivos. Confira o erro no Actions e publique a correção com uma versão
  maior pelo fluxo normal de release.

A configuração do destino fica em `electron-builder.yml`: provedor `github`,
proprietário `erickgustavo1816-ctrl`, repositório `synkora-releases` e
`releaseType: release`. O workflow usa esse destino ao empacotar.
