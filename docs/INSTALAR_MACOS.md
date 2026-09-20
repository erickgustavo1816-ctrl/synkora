# Primeira instalação no Mac com Apple Silicon

O pacote deve ser construído no próprio Mac, com Node `arm64`. As mudanças de suporte foram verificadas com testes isolados no Windows; a primeira execução nativa no Mac ainda precisa ser validada.

## Preparar o Mac

1. Use um Terminal nativo, sem Rosetta, e instale Node LTS para Apple Silicon. Este repositório exige Node **22.12 ou superior** para instalar suas ferramentas; Node 24 LTS atende ao requisito. Confirme com `node -p "process.platform + ' ' + process.arch"`: o resultado deve ser `darwin arm64`.
2. Clone a versão atual do repositório no Mac. Não copie `node_modules`, SDKs ou aparelhos virtuais do Windows. Rode `npm ci` na pasta do projeto, mantendo as dependências opcionais habilitadas. Elas contêm o terminal e o compilador nativos de cada arquitetura.
3. Instale e autentique no Mac o CLI de IA que pretende usar no Synkora. O aplicativo recupera o PATH do shell de login quando abre pelo Finder. Isso não copia contas nem credenciais de outra máquina.
4. Para usar Android e iOS juntos, prepare os dois ambientes descritos abaixo. O Electron 43 suporta macOS Monterey ou superior, mas **o idb atual para interação iOS exige macOS 15+ e Xcode 26+**. Verifique esses requisitos antes de escolher versões. [Electron 43](https://github.com/electron/electron/tree/v43.1.1#platform-support), [instalação oficial do idb](https://github.com/facebook/idb/blob/main/website/docs/idb/installation.mdx).

## Verificar e gerar o aplicativo

Na pasta do repositório:

```sh
npm ci
npm run check:mac
npm run test:gui-system
npm run dist:mac
```

`check:mac` apenas verifica arquivos e consulta versões/listas locais. Não inicia o Synkora, emuladores ou simuladores, não abre contas e não salva identificadores de aparelhos. Os campos `requiredChecksPass` e `mobilePrerequisitesPresent` indicam pré-requisitos encontrados; `nativeValidation: pending` lembra que isso não demonstra funcionamento de uma sessão real. A ausência de um SDK mobile não impede gerar o aplicativo desktop.

`dist:mac` gera DMG e ZIP arm64 em `release/`, usando somente as ferramentas instaladas no projeto e com publicação desabilitada. Esse comando não herda variáveis de assinatura/notarização de releases e desliga a busca automática de identidades. Para gerar apenas a pasta `.app`, use `npm run dist:mac:dir`. O ícone de 1024 pixels já está no repositório; para regenerá-lo da geometria original, use `node scripts/make-icon.mjs --mac-only`.

O pacote usa **assinatura ad-hoc local**. Ela permite verificar a integridade do bundle e não equivale a uma distribuição assinada com Developer ID e notarizada pela Apple. Instale o aplicativo produzido no seu Mac e abra pelo Finder. Se o sistema bloquear a abertura, confira a origem e o diagnóstico do macOS; não desative o Gatekeeper. Distribuição pública exigirá uma configuração separada de assinatura/notarização e sua autorização. [Assinatura no Electron](https://www.electronjs.org/docs/latest/tutorial/code-signing).

O build inclui o terminal nativo, o TypeScript arm64 fora do ASAR e o servidor Android scrcpy 4.1. Não há necessidade de instalar o aplicativo desktop scrcpy. A primeira execução ainda deve confirmar o carregamento desses binários no Mac.

## Android com Play Store

Instale a edição **Apple Silicon** do Android Studio pela distribuição oficial. No SDK Manager, instale Android Emulator e Android SDK Platform-Tools. O Synkora reconhece o SDK padrão em `~/Library/Android/sdk`; instalações alternativas podem usar `ANDROID_HOME` ou `ANDROID_SDK_ROOT` no ambiente de inicialização.

No Device Manager, crie um aparelho Pixel compatível com Google Play e selecione uma imagem **Google Play API 36, arm64-v8a**. O pacote oficial é `system-images;android-36;google_apis_playstore;arm64-v8a`. Pode usar o nome `Synkora_Play_Store_API_36` se ainda não existir no Mac. Não substitua um aparelho que já contenha dados. A imagem `x86_64` usada no Windows não é a imagem adequada para Apple Silicon; a aceleração do Mac usa o Hypervisor.Framework. [Aceleração oficial](https://developer.android.com/studio/run/emulator-acceleration), [catálogo oficial das imagens Google Play](https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml).

Depois, no Synkora, abra uma missão e atualize o painel Mobile. Inicie o aparelho pelo próprio painel. Um emulador já aberto fora do Synkora não é adotado automaticamente. A Play Store vem na imagem oficial; entrar em uma conta Google é uma ação sua dentro do aparelho.

A qualidade e o desempenho do vídeo, o toque contínuo, a rotação e a execução simultânea com iOS precisam ser medidos no Mac. Os resultados de desempenho observados no Windows não comprovam a mesma taxa no MacBook.

## iPhone no simulador do Mac

Instale o **Xcode completo**, abra-o para concluir a preparação e selecione sua instalação em Settings → Locations → Command Line Tools. Instale um runtime iOS em Settings → Components e crie um iPhone em Window → Devices and Simulators. Apenas instalar Command Line Tools não fornece o ambiente completo necessário. [Componentes do Xcode](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

Para toques e teclado integrados, a receita atual do projeto idb é:

```sh
brew install facebook/fb/idb
```

Essa fórmula instala tanto `idb` quanto `idb_companion`. A versão oficial consultada em 20/09/2026 fornece companion para arm64 e requer macOS 15+, Xcode 26+ e suas dependências Python via Homebrew. Não misture uma receita antiga de `pip` com outro companion sem validar a compatibilidade. [Receita oficial](https://github.com/facebook/homebrew-fb/blob/main/idb.rb), [requisitos do companion](https://github.com/facebook/homebrew-fb/blob/main/idb-companion.rb).

Atualize o painel Mobile e escolha o iPhone. Instale um `.app` **compilado para iOS Simulator**, dentro do worktree da missão. Um IPA de iPhone físico ou aplicativo macOS não substitui essa compilação.

O suporte atual usa `simctl` para iniciar, instalar, abrir aplicativos e capturar a tela. **A imagem iOS é atualizada por capturas periódicas**, com intervalo de 900 ms depois de cada resposta; o vídeo contínuo e o toque contínuo implementados para Android não são transportes de iOS. O input iOS depende de `idb` responder com geometria verificável. Sem isso, a imagem e a instalação continuam disponíveis, com interação limitada. Valide toque, swipe, teclado, orientação, encerramento e dois aparelhos lado a lado no Mac antes de depender desse fluxo.

## Usar Android e iPhone lado a lado

No painel Mobile, inicie o Android e clique em **↗** ao lado de **Parar** para destacar o aparelho. Selecione a aba **iOS**, inicie o iPhone e destaque-o da mesma forma. Arraste as janelas pela barra com o nome do modelo para colocá-las lado a lado. Cada uma continua ligada à sua própria sessão.

Modelos com medidas conhecidas abrem em **Tamanho real**, usando os dados físicos do monitor. Os controles **Ajustar**, **Real** e zoom ficam acima do aparelho. Modelos desconhecidos usam **Ajustar**. Se o aparelho não couber na área disponível, reduza o zoom ou use Ajustar.

**↙** e **×** devolvem a visualização ao painel sem desligar o aparelho. Para desligá-lo, use **Parar** no painel Mobile. O painel ocupa sempre uma coluna inteira, inclusive ao restaurar um layout salvo com outro painel acima ou abaixo.

Após atualizar esta versão, feche e reabra o Synkora para carregar o suporte às novas janelas.

## Expo

Abra uma missão de um projeto Expo com suas dependências locais instaladas. O repositório Synkora é um aplicativo Electron e não roda dentro do Expo Go. A detecção lê o `package.json`; ela não converte automaticamente um projeto.

Os botões integrados de instalar Expo Go e abrir o projeto controlam o Android. Para iOS Simulator, prepare uma versão compatível do aplicativo de simulador conforme a documentação Expo. Um iPhone físico pode usar o QR na mesma rede e a mesma conta Expo do CLI; esse fluxo não espelha sua tela no Synkora.

A versão do Expo Go deve corresponder ao SDK do projeto. A orientação oficial atual informa que a versão da App Store termina no SDK 54; SDK 55+ em iPhone físico exige uma distribuição compatível via TestFlight/EAS Go e a participação necessária no Apple Developer Program. O Synkora não inicia builds em nuvem automaticamente. Android e iOS Simulator podem receber versões compatíveis específicas. [Compatibilidade oficial](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/).

## Escala física e dados locais

No Mac, a escala automática consulta os milímetros reportados por CoreGraphics e os vincula à tela da janela que solicitou a medição. Retina, modos com mais espaço e zoom usam as unidades atuais de renderização. A resolução sozinha nunca define polegadas. Valores ausentes, ambíguos, espelhados ou consistentes com a estimativa padrão de 72 dpi são recusados; nesses casos a interface mantém uma estimativa explícita e oferece ajuste manual opcional. As medidas reportadas pelo sistema não são uma calibração certificada.

O aplicativo instalado usa `~/Library/Application Support/Synkora`; o modo de desenvolvimento usa `~/Library/Application Support/Synkora-Dev`. As pastas são distintas mesmo no APFS sem diferenciação de maiúsculas. Nenhum dado anterior é migrado automaticamente. Se já existia uma execução de desenvolvimento no Mac, faça uma migração deliberada em separado, com backup, em vez de copiar stores às cegas.

Na primeira execução real, valide: abertura pelo Finder, uma conversa com o CLI, terminal, diagnóstico TypeScript em projeto sem TypeScript próprio, SynVoice após autorizar o microfone, monitor interno/externo e os dois aparelhos virtuais. A implementação e os testes simulados não substituem essa rodada nativa.
